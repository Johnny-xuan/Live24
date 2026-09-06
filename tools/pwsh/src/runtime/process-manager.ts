import { randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  INTERRUPT,
  MAX_PROCESSES,
  PROTECTED_RECENT_PROCESSES,
  PTY_REACTION_DELAY_MS,
  STREAM_UPDATE_THROTTLE_MS,
} from "../constants.js";
import type { ViewportOptions } from "../output/headless-terminal-state.js";
import { presentOutput } from "../output/presenter.js";
import {
  clampExecYield,
  clampWriteYield,
  createChunkId,
  resolveExecInput,
  resolveWriteInput,
  type ExecCommandInput,
  type NativeExecInput,
  type UnifiedExecDetails,
  type WriteStdinInput,
} from "../protocol.js";
import { ArtifactStore, type ArtifactSpool } from "./artifact-store.js";
import { AsyncMutex } from "./async-mutex.js";
import { buildChildEnvironment, type PiSessionEnvironment } from "./environment.js";
import { ManagedProcess } from "./managed-process.js";
import { resolveNativeCommand, resolveShell, type ResolvedCommand } from "./shell.js";
import { normalizeTerminalSize, type TerminalSize } from "./terminal-size.js";

export interface ManagerCallContext {
  cwd: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  sessionEnvironment?: PiSessionEnvironment;
  signal?: AbortSignal;
  onUpdate?: (details: UnifiedExecDetails) => void;
  timeoutMs?: number;
  terminalSize?: TerminalSize;
  shellPreference?: "legacy" | "powershell";
  nativePowerShell?: boolean;
  windowsYieldFloor?: boolean;
}

export interface ProcessSummary {
  session_id: number;
  pid: number;
  command: string[];
  workdir: string;
  tty: boolean;
  exited: boolean;
  attached: boolean;
  cols?: number;
  rows?: number;
}

export class ProcessAttachment {
  readonly session_id: number;
  readonly pid: number;
  readonly command: string[];
  readonly workdir: string;
  #process: ManagedProcess;
  #releaseLease: () => void;
  #released = false;

  constructor(process: ManagedProcess, releaseLease: () => void) {
    this.#process = process;
    this.#releaseLease = releaseLease;
    this.session_id = process.id;
    this.pid = process.pid;
    this.command = process.command;
    this.workdir = process.cwd;
  }

  get exited(): boolean {
    return this.#process.hasExited;
  }

  get exitCode(): number | null {
    return this.#process.exitCode;
  }

  get size(): TerminalSize {
    return this.#process.terminalSize ?? normalizeTerminalSize();
  }

  write(data: string): void {
    this.#assertActive();
    if (this.#process.hasExited) throw new Error(`Process ${this.session_id} has already exited`);
    this.#process.write(data);
  }

  resize(size: TerminalSize): void {
    this.#assertActive();
    this.#process.resize(size);
  }

  viewportLines(options: ViewportOptions = {}): string[] {
    return this.#process.viewportLines(options);
  }

  subscribe(listener: () => void): () => void {
    this.#assertActive();
    return this.#process.subscribeOutput(listener);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#releaseLease();
  }

  #assertActive(): void {
    if (this.#released) throw new Error(`Attachment for process ${this.session_id} has been released`);
  }
}

export type StdinOperation = "poll" | "pty_write" | "interrupt" | "stdin_closed";

export function resolveStdinOperation(tty: boolean, chars: string): StdinOperation {
  if (chars.length === 0) return "poll";
  if (tty) return "pty_write";
  return chars === INTERRUPT ? "interrupt" : "stdin_closed";
}

export interface PruneMetadata {
  id: number;
  lastUsed: number;
  exited: boolean;
  locked: boolean;
}

export function selectPruneId(
  entries: PruneMetadata[],
  maxProcesses = MAX_PROCESSES,
  protectedRecent = PROTECTED_RECENT_PROCESSES,
): number | undefined {
  if (entries.length < maxProcesses) return undefined;
  const protectedIds = new Set(
    [...entries]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, protectedRecent)
      .map((entry) => entry.id),
  );
  const eligible = entries.filter((entry) => !protectedIds.has(entry.id));
  const exited = eligible.filter((entry) => entry.exited).sort((a, b) => a.lastUsed - b.lastUsed);
  const unlockedExited = exited.find((entry) => !entry.locked);
  if (unlockedExited) return unlockedExited.id;
  if (exited.length > 0) return undefined;
  return eligible
    .filter((entry) => !entry.exited && !entry.locked)
    .sort((a, b) => a.lastUsed - b.lastUsed)[0]?.id;
}

function assertNoNul(value: string, label: string): void {
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL characters`);
}

function abortError(): Error {
  const error = new Error("Unified Exec interaction aborted");
  error.name = "AbortError";
  return error;
}

function processFailureError(
  snapshot: ReturnType<ManagedProcess["snapshotOutput"]>,
  maxOutputTokens: number,
  failure: string,
): Error {
  const presented = presentOutput(snapshot, maxOutputTokens);
  const output = presented.text ? `${presented.text}\n\n` : "";
  return new Error(`${output}${failure}`);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ProcessManager {
  readonly artifacts: ArtifactStore;
  #processes = new Map<number, ManagedProcess>();
  #reservedIds = new Set<number>();
  #storeLock = new AsyncMutex();
  #closed = false;
  #shutdownPromise?: Promise<void>;
  #admissionReservations = 0;
  #admissionIdleWaiters = new Set<() => void>();
  #shutdownCleanupFailures: string[] = [];
  readonly #maxProcesses: number;

  private constructor(artifacts: ArtifactStore, maxProcesses: number) {
    this.artifacts = artifacts;
    this.#maxProcesses = Math.max(1, Math.floor(maxProcesses));
  }

  static async create(options: { maxProcesses?: number } = {}): Promise<ProcessManager> {
    return new ProcessManager(await ArtifactStore.create(), options.maxProcesses ?? MAX_PROCESSES);
  }

  get size(): number {
    return this.#processes.size;
  }

  list(): ProcessSummary[] {
    return Array.from(this.#processes.values())
      .sort((a, b) => a.id - b.id)
      .map((process) => ({
        session_id: process.id,
        pid: process.pid,
        command: process.command,
        workdir: process.cwd,
        tty: process.tty,
        exited: process.hasExited,
        attached: process.attached,
        ...(process.terminalSize ?? {}),
      }));
  }

  attach(sessionId: number): ProcessAttachment {
    if (this.#closed) throw new Error("Unified Exec manager is shut down");
    const process = this.#processes.get(sessionId);
    if (!process) throw new Error(`Unknown process id ${sessionId}`);
    const releaseLease = process.acquireAttachment();
    return new ProcessAttachment(process, releaseLease);
  }

  resizePtys(size: TerminalSize): void {
    const normalized = normalizeTerminalSize(size);
    for (const process of this.#processes.values()) process.resize(normalized);
  }

  async execCommand(input: ExecCommandInput, context: ManagerCallContext): Promise<UnifiedExecDetails> {
    if (this.#closed) throw new Error("Unified Exec manager is shut down");
    const args = resolveExecInput(input);
    if (args.cmd.trim().length === 0) throw new Error("cmd must not be blank");
    assertNoNul(args.cmd, "command");
    if (args.shell) assertNoNul(args.shell, "shell");
    const workdir = await this.#resolveWorkdir(context.cwd, args.workdir);
    const env = buildChildEnvironment(context.inheritedEnv, context.sessionEnvironment, { tty: args.tty });
    const command = resolveShell(args.cmd, {
      shell: args.shell,
      login: args.login,
      tty: args.tty,
      env,
      preferPowerShell: context.shellPreference === "powershell",
      nativePowerShell: context.nativePowerShell,
    });
    return this.#execResolved(command, workdir, env, args.tty, args.yield_time_ms, args.max_output_tokens, context);
  }

  async execNative(input: NativeExecInput, context: ManagerCallContext): Promise<UnifiedExecDetails> {
    if (this.#closed) throw new Error("Unified Exec manager is shut down");
    if (!input.executable.trim()) throw new Error("executable must not be blank");
    assertNoNul(input.executable, "executable");
    input.args.forEach((arg, index) => assertNoNul(arg, `argument ${index}`));
    const workdir = await this.#resolveWorkdir(context.cwd, input.workdir);
    const env = buildChildEnvironment(context.inheritedEnv, context.sessionEnvironment, { tty: input.tty });
    const command = resolveNativeCommand(input.executable, input.args, env);
    return this.#execResolved(command, workdir, env, input.tty, input.yield_time_ms, input.max_output_tokens, context);
  }

  async #execResolved(
    command: ResolvedCommand,
    workdir: string,
    env: NodeJS.ProcessEnv,
    tty: boolean,
    yieldTimeMs: number,
    maxOutputTokens: number,
    context: ManagerCallContext,
  ): Promise<UnifiedExecDetails> {
    await this.#reserveAdmission();
    let processId: number;
    try {
      processId = this.#allocateId();
    } catch (error) {
      await this.#releaseAdmission();
      throw error;
    }
    let artifact: ArtifactSpool;
    try {
      if (this.#closed) throw new Error("Unified Exec manager is shut down");
      artifact = await this.artifacts.createSpool(processId);
    } catch (error) {
      this.#reservedIds.delete(processId);
      await this.#releaseAdmission();
      if (this.#closed) throw new Error("Unified Exec manager is shut down");
      throw error;
    }
    let process: ManagedProcess;

    try {
      process = await ManagedProcess.spawn({
        id: processId,
        shell: command,
        cwd: workdir,
        env,
        tty,
        artifact,
        timeoutMs: context.timeoutMs,
        terminalSize: context.terminalSize,
      });
    } catch (error) {
      this.#reservedIds.delete(processId);
      try {
        await artifact.remove();
      } finally {
        await this.#releaseAdmission();
      }
      throw error;
    }

    const releaseInteraction = await process.interactionLock.acquire();
    try {
      await this.#insert(process);
    } catch (error) {
      releaseInteraction();
      throw error;
    }
    const chunkId = createChunkId();
    let stopUpdates: () => void = () => {};

    try {
      await process.classifyEarlyExit(context.signal);
      const waitStarted = performance.now();
      stopUpdates = this.#startStreaming(process, chunkId, maxOutputTokens, waitStarted, context.onUpdate);
      const wallTimeMs = await process.waitForInteraction(
        clampExecYield(yieldTimeMs, globalThis.process.platform, context.windowsYieldFloor ?? true),
        context.signal,
      );
      await process.flushOutput();
      stopUpdates();
      const snapshot = process.drainOutput();
      if (process.failure) throw processFailureError(snapshot, maxOutputTokens, process.failure);
      const completed = process.hasExited && process.outputClosed;
      const status = completed ? "exited" : "running";
      const details = await this.#buildDetails(process, snapshot, status, chunkId, wallTimeMs, maxOutputTokens);

      if (completed) {
        await this.#removeIfSame(process);
        await this.#cleanupRemoved(process);
      }
      return details;
    } catch (error) {
      stopUpdates();
      if ((error as Error).name === "AbortError" || process.failure) await process.terminate();
      if ((error as Error).name === "AbortError" || process.failure) {
        await this.#removeIfSame(process);
        process.dispose();
        await process.artifact.remove();
      }
      throw error;
    } finally {
      releaseInteraction();
    }
  }

  async writeStdin(input: WriteStdinInput, context: Omit<ManagerCallContext, "cwd">): Promise<UnifiedExecDetails> {
    if (this.#closed) throw new Error("Unified Exec manager is shut down");
    const args = resolveWriteInput(input);
    const process = this.#processes.get(args.session_id);
    if (!process) throw new Error(`Unknown process id ${args.session_id}`);
    if (process.attached) throw new Error(`Process ${args.session_id} is attached by the user; wait for detach before using write_stdin`);
    const releaseInteraction = await process.interactionLock.acquire();
    const chunkId = createChunkId();
    let stopUpdates: () => void = () => {};

    try {
      if (this.#closed) throw new Error("Unified Exec manager is shut down");
      if (this.#processes.get(args.session_id) !== process) throw new Error(`Unknown process id ${args.session_id}`);
      if (process.attached) throw new Error(`Process ${args.session_id} is attached by the user; wait for detach before using write_stdin`);
      process.lastUsed = performance.now();
      const operation = resolveStdinOperation(process.tty, args.chars);
      if (operation === "pty_write") {
        process.write(args.chars);
        await delay(PTY_REACTION_DELAY_MS, context.signal);
      } else if (operation === "interrupt") {
        await process.interrupt();
      } else if (operation === "stdin_closed") {
        throw new Error(`stdin is closed for this session; rerun ${globalThis.process.platform === "win32" ? "powershell" : "bash"} with tty=true to keep stdin open`);
      }

      const waitStarted = performance.now();
      stopUpdates = this.#startStreaming(process, chunkId, args.max_output_tokens, waitStarted, context.onUpdate);
      const wallTimeMs = await process.waitForInteraction(clampWriteYield(args.yield_time_ms, args.chars.length === 0), context.signal);
      await process.flushOutput();
      stopUpdates();
      const snapshot = process.drainOutput();
      if (process.failure) throw processFailureError(snapshot, args.max_output_tokens, process.failure);
      const completed = process.hasExited && process.outputClosed;
      const status = completed ? "exited" : "running";
      const details = await this.#buildDetails(process, snapshot, status, chunkId, wallTimeMs, args.max_output_tokens);

      if (completed) {
        await this.#removeIfSame(process);
        await this.#cleanupRemoved(process);
      }
      return details;
    } catch (error) {
      if (process.failure) {
        await process.terminate();
        await this.#removeIfSame(process);
        await this.#cleanupRemoved(process);
      }
      throw error;
    } finally {
      stopUpdates();
      releaseInteraction();
    }
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#closed = true;
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
  }

  async #finishShutdown(): Promise<void> {
    const release = await this.#storeLock.acquire();
    const processes = Array.from(this.#processes.values());
    this.#processes.clear();
    this.#reservedIds.clear();
    release();
    const terminations = await Promise.allSettled(processes.map((process) => process.terminate()));
    for (const [index, result] of terminations.entries()) {
      if (result.status === "rejected") this.#shutdownCleanupFailures.push(String(result.reason));
      const failure = processes[index]?.failure;
      if (failure) this.#shutdownCleanupFailures.push(failure);
    }
    for (const process of processes) process.dispose();
    await this.#waitForAdmissionsToDrain();
    await this.artifacts.shutdown();
    const failures = Array.from(new Set(this.#shutdownCleanupFailures));
    if (failures.length > 0) {
      throw new Error(`Managed process cleanup was incomplete: ${failures.join("; ")}`);
    }
  }

  async #buildDetails(
    process: ManagedProcess,
    snapshot: ReturnType<ManagedProcess["snapshotOutput"]>,
    status: "running" | "exited",
    chunkId: string,
    wallTimeMs: number,
    maxOutputTokens: number,
  ): Promise<UnifiedExecDetails> {
    const presented = presentOutput(snapshot, maxOutputTokens);
    const shouldExposeArtifact = snapshot.omittedBytes > 0 || presented.truncated || process.artifact.exposed;
    const details: UnifiedExecDetails = {
      version: 1,
      status,
      chunk_id: chunkId,
      wall_time_seconds: wallTimeMs / 1000,
      exit_code: status === "exited" ? process.exitCode : null,
      session_id: status === "running" ? process.id : null,
      original_token_count: presented.originalTokenCount,
      output_omitted_bytes: presented.omittedBytes,
      output: presented.text,
    };

    if (shouldExposeArtifact) {
      await process.artifact.flush();
      const artifact = process.artifact.expose();
      if (artifact === "unavailable") details.output_artifact_error = "unavailable";
      else details.output_artifact = artifact;
    }
    return details;
  }

  #startStreaming(
    process: ManagedProcess,
    chunkId: string,
    maxOutputTokens: number,
    waitStarted: number,
    onUpdate?: (details: UnifiedExecDetails) => void,
  ): () => void {
    if (!onUpdate) return () => undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const emit = () => {
      timer = undefined;
      if (stopped) return;
      const snapshot = process.snapshotOutput();
      const presented = presentOutput(snapshot, maxOutputTokens);
      try {
        onUpdate({
          version: 1,
          status: "streaming",
          chunk_id: chunkId,
          wall_time_seconds: Math.max(0, performance.now() - waitStarted) / 1000,
          exit_code: null,
          session_id: null,
          original_token_count: presented.originalTokenCount,
          output_omitted_bytes: presented.omittedBytes,
          output: presented.text,
        });
      } catch {
        // Renderer/update failures must not affect the child process.
      }
    };
    const schedule = () => {
      if (!stopped && !timer) timer = setTimeout(emit, STREAM_UPDATE_THROTTLE_MS);
    };
    const unsubscribe = process.subscribeOutput(schedule);
    if (process.snapshotOutput().totalBytes > 0) schedule();
    return () => {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
  }

  async #resolveWorkdir(sessionCwd: string, requested?: string): Promise<string> {
    if (requested) {
      assertNoNul(requested, "workdir");
      if (process.platform === "win32" && /^[A-Za-z]:(?:$|[^\\/])/.test(requested)) {
        throw new Error(`workdir must not use a drive-relative Windows path: ${requested}`);
      }
    }
    const resolved = requested ? (path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(sessionCwd, requested)) : sessionCwd;
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`workdir is not a directory: ${resolved}`);
    return resolved;
  }

  #allocateId(): number {
    for (;;) {
      const id = randomInt(1_000, 100_000);
      if (this.#reservedIds.has(id)) continue;
      this.#reservedIds.add(id);
      return id;
    }
  }

  async #reserveAdmission(): Promise<void> {
    const release = await this.#storeLock.acquire();
    if (this.#closed) {
      release();
      throw new Error("Unified Exec manager is shut down");
    }
    let pruned: ManagedProcess | undefined;
    if (this.#processes.size + this.#admissionReservations >= this.#maxProcesses) {
      if (this.#processes.size >= this.#maxProcesses) pruned = this.#selectPruneCandidate();
      if (!pruned) {
        release();
        throw new Error(`Managed process limit (${this.#maxProcesses}) reached; retry after an active interaction finishes`);
      }
      this.#processes.delete(pruned.id);
      this.#reservedIds.delete(pruned.id);
    }
    this.#admissionReservations += 1;
    release();

    if (pruned) {
      try {
        if (!pruned.hasExited || !pruned.outputClosed) await pruned.terminate();
        const cleanupFailure = pruned.failure;
        await this.#cleanupRemoved(pruned);
        if (cleanupFailure) throw new Error(cleanupFailure);
      } catch (error) {
        await this.#releaseAdmission();
        throw error;
      }
    }
  }

  async #releaseAdmission(): Promise<void> {
    const release = await this.#storeLock.acquire();
    this.#admissionReservations = Math.max(0, this.#admissionReservations - 1);
    const waiters = this.#takeAdmissionIdleWaiters();
    release();
    for (const resolve of waiters) resolve();
  }

  async #waitForAdmissionsToDrain(): Promise<void> {
    const release = await this.#storeLock.acquire();
    if (this.#admissionReservations === 0) {
      release();
      return;
    }
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    this.#admissionIdleWaiters.add(resolveIdle);
    release();
    await idle;
  }

  #takeAdmissionIdleWaiters(): Array<() => void> {
    if (this.#admissionReservations !== 0 || this.#admissionIdleWaiters.size === 0) return [];
    const waiters = Array.from(this.#admissionIdleWaiters);
    this.#admissionIdleWaiters.clear();
    return waiters;
  }

  async #insert(process: ManagedProcess): Promise<void> {
    const release = await this.#storeLock.acquire();
    if (this.#closed) {
      this.#reservedIds.delete(process.id);
      release();
      try {
        try {
          await process.terminate();
        } finally {
          process.dispose();
          await process.artifact.remove();
        }
        if (process.failure) this.#shutdownCleanupFailures.push(process.failure);
      } catch (error) {
        this.#shutdownCleanupFailures.push(String(error));
        throw error;
      } finally {
        await this.#releaseAdmission();
      }
      throw new Error("Unified Exec manager is shut down");
    }
    this.#admissionReservations = Math.max(0, this.#admissionReservations - 1);
    const waiters = this.#takeAdmissionIdleWaiters();
    this.#processes.set(process.id, process);
    release();
    for (const resolve of waiters) resolve();
  }

  #selectPruneCandidate(): ManagedProcess | undefined {
    if (this.#processes.size < this.#maxProcesses) return undefined;
    const entries = Array.from(this.#processes.values());
    const selectedId = selectPruneId(entries.map((entry) => ({
      id: entry.id,
      lastUsed: entry.lastUsed,
      exited: entry.hasExited && entry.outputClosed,
      locked: entry.interactionLock.isLocked,
    })), this.#maxProcesses, Math.min(PROTECTED_RECENT_PROCESSES, this.#maxProcesses));
    if (selectedId === undefined) return undefined;
    const candidate = this.#processes.get(selectedId);
    if (!candidate) return undefined;
    const unlock = candidate.interactionLock.tryAcquire();
    if (!unlock) return undefined;
    unlock();
    return candidate;
  }

  async #removeIfSame(process: ManagedProcess): Promise<void> {
    const release = await this.#storeLock.acquire();
    if (this.#processes.get(process.id) === process) {
      this.#processes.delete(process.id);
      this.#reservedIds.delete(process.id);
    }
    release();
  }

  async #cleanupRemoved(process: ManagedProcess): Promise<void> {
    process.dispose();
    if (!process.artifact.exposed || process.artifact.unavailable) await process.artifact.remove();
  }
}
