import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { IDisposable, IPty } from "@lydell/node-pty";
import { spawnPty } from "./pty-adapter.js";
import {
  EARLY_EXIT_GRACE_MS,
  POST_EXIT_CLOSE_GRACE_MS,
} from "../constants.js";
import { Utf8DecoderBank } from "../output/decoder.js";
import { AnsiSanitizer } from "../output/ansi-sanitizer.js";
import { Ecma48Framer } from "../output/ecma48-framer.js";
import { HeadlessTerminalState, type ViewportOptions } from "../output/headless-terminal-state.js";
import { combineOutputSnapshots, HeadTailBuffer, type OutputSnapshot } from "../output/head-tail-buffer.js";
import { AsyncMutex } from "./async-mutex.js";
import { OutputIngestionController, type OutputStreamId } from "./output-ingestion.js";
import type { ArtifactSpool } from "./artifact-store.js";
import type { ResolvedShell } from "./shell.js";
import { normalizeTerminalSize, type TerminalSize } from "./terminal-size.js";

export interface SpawnProcessOptions {
  id: number;
  shell: ResolvedShell;
  cwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
  artifact: ArtifactSpool;
  timeoutMs?: number;
  terminalSize?: TerminalSize;
}

type OutputListener = () => void;

function abortError(): Error {
  const error = new Error("Unified Exec interaction aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
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

export class ManagedProcess {
  readonly id: number;
  readonly tty: boolean;
  readonly cwd: string;
  readonly command: string[];
  readonly interactionLock = new AsyncMutex();
  readonly artifact: ArtifactSpool;
  lastUsed = performance.now();

  #pid: number;
  #child?: ChildProcess;
  #pty?: IPty;
  #ptyData?: IDisposable;
  #ptyExit?: IDisposable;
  #decoders = new Utf8DecoderBank<OutputStreamId>();
  #framers = new Map<OutputStreamId, Ecma48Framer>();
  #expectedStreams: OutputStreamId[];
  #sanitizer: AnsiSanitizer;
  #ingestion: OutputIngestionController;
  #terminalState?: HeadlessTerminalState;
  #pending = new HeadTailBuffer();
  #listeners = new Set<OutputListener>();
  #exitWaiters = new Set<() => void>();
  #closeWaiters = new Set<() => void>();
  #exited = false;
  #outputClosed = false;
  #outputClosing?: Promise<void>;
  #exitCode: number | null = null;
  #failure?: string;
  #terminating?: Promise<void>;
  #timeoutTimer?: NodeJS.Timeout;
  #attached = false;

  private constructor(options: SpawnProcessOptions, pid: number) {
    this.id = options.id;
    this.tty = options.tty;
    this.cwd = options.cwd;
    this.command = options.shell.argv;
    this.artifact = options.artifact;
    this.#pid = pid;
    this.#expectedStreams = options.tty ? ["pty"] : ["stdout", "stderr"];
    const terminalSize = normalizeTerminalSize(options.terminalSize);
    this.#sanitizer = new AnsiSanitizer(undefined, terminalSize, {
      externalFullScreen: options.tty,
      externalScreen: options.tty,
    });
    if (options.tty) {
      this.#terminalState = new HeadlessTerminalState(terminalSize.cols, terminalSize.rows, {
        onResponse: (data) => {
          if (!this.#exited && this.#pty) this.#pty.write(data);
        },
        onChange: () => this.#notifyOutput(),
      });
    }
    this.#ingestion = new OutputIngestionController({
      pressures: [this.artifact, ...(this.#terminalState ? [this.#terminalState] : [])],
      consume: (chunk, stream) => this.#projectRaw(chunk, stream),
      onSourceEnd: (stream) => this.#endDecodedStream(stream),
      onTurn: () => this.#notifyOutput(),
      onConsumeError: (error) => {
        this.#failure ??= `Output projection failed: ${(error as Error).message ?? String(error)}`;
      },
    });
  }

  static async spawn(options: SpawnProcessOptions): Promise<ManagedProcess> {
    return options.tty ? this.#spawnPty(options) : this.#spawnPipes(options);
  }

  static async #spawnPipes(options: SpawnProcessOptions): Promise<ManagedProcess> {
    const child = spawn(options.shell.executable, options.shell.argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const managed = new ManagedProcess(options, child.pid ?? -1);
    managed.#child = child;
    managed.#ingestion.setSource({
      pause: () => {
        child.stdout?.pause();
        child.stderr?.pause();
      },
      resume: () => {
        child.stdout?.resume();
        child.stderr?.resume();
      },
    });

    child.stdout?.on("data", (chunk: Buffer) => managed.#consumeRaw(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => managed.#consumeRaw(chunk, "stderr"));
    child.stdout?.on("end", () => managed.#ingestion.endSource("stdout"));
    child.stderr?.on("end", () => managed.#ingestion.endSource("stderr"));
    child.on("exit", (code) => managed.#markExited(code));
    child.on("close", () => void managed.#markOutputClosed());
    child.on("error", (error) => {
      managed.#failure = error.message;
      managed.#markExited(null);
      void managed.#markOutputClosed();
    });

    await new Promise<void>((resolve, reject) => {
      if (child.pid) {
        resolve();
        return;
      }
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    managed.#armTimeout(options.timeoutMs);
    return managed;
  }

  static async #spawnPty(options: SpawnProcessOptions): Promise<ManagedProcess> {
    const terminalSize = normalizeTerminalSize(options.terminalSize);
    const pty = await spawnPty(options.shell.executable, options.shell.argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      ...terminalSize,
    });
    const managed = new ManagedProcess(options, pty.pid);
    managed.#pty = pty;
    managed.#ingestion.setSource({
      pause: () => pty.pause(),
      resume: () => pty.resume(),
    });
    managed.#ptyData = pty.onData(((data: string | Buffer) => {
      managed.#consumeRaw(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), "pty");
    }) as (data: string) => void);
    managed.#ptyExit = pty.onExit(({ exitCode }) => {
      managed.#ingestion.endSource("pty");
      managed.#markExited(exitCode);
      queueMicrotask(() => void managed.#markOutputClosed());
    });
    managed.#armTimeout(options.timeoutMs);
    return managed;
  }

  get pid(): number {
    return this.#pid;
  }

  get hasExited(): boolean {
    return this.#exited;
  }

  get outputClosed(): boolean {
    return this.#outputClosed;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get failure(): string | undefined {
    return this.#failure;
  }

  get attached(): boolean {
    return this.#attached;
  }

  get terminalSize(): TerminalSize | undefined {
    return this.#terminalState ? { cols: this.#terminalState.cols, rows: this.#terminalState.rows } : undefined;
  }

  snapshotOutput(): OutputSnapshot {
    const terminalScreenActive = this.#terminalScreenActive();
    const live = terminalScreenActive
      ? this.#terminalState!.snapshotDelta()
      : this.#sanitizer.snapshotCurrentLineDelta();
    return combineOutputSnapshots(this.#pending.snapshot(), live, this.#pending.maxBytes);
  }

  drainOutput(): OutputSnapshot {
    const terminalScreenActive = this.#terminalScreenActive();
    const live = terminalScreenActive
      ? this.#terminalState!.snapshotDelta()
      : this.#sanitizer.snapshotCurrentLineDelta();
    const snapshot = combineOutputSnapshots(this.#pending.drain(), live, this.#pending.maxBytes);
    if (terminalScreenActive) this.#terminalState!.markDelivered();
    else this.#sanitizer.markCurrentLineDelivered();
    return snapshot;
  }

  #terminalScreenActive(): boolean {
    return !!this.#terminalState?.available
      && (this.#terminalState.hasPendingSnapshot || this.#sanitizer.screenMode);
  }

  async flushOutput(): Promise<void> {
    await this.#ingestion.flush();
    await this.#terminalState?.flush();
  }

  acquireAttachment(): () => void {
    if (!this.tty || !this.#terminalState) throw new Error(`Process ${this.id} is not a PTY session`);
    if (this.#exited) throw new Error(`Process ${this.id} has already exited`);
    if (this.#attached) throw new Error(`Process ${this.id} is already attached by the user`);
    const releaseInteraction = this.interactionLock.tryAcquire();
    if (!releaseInteraction) throw new Error(`Process ${this.id} is busy with an Agent interaction`);
    this.#attached = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#attached = false;
      releaseInteraction();
    };
  }

  viewportLines(options: ViewportOptions = {}): string[] {
    if (!this.#terminalState) return [];
    return this.#terminalState.viewportLines(options);
  }

  subscribeOutput(listener: OutputListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#ingestion.dispose();
    this.#terminalState?.dispose();
    this.#terminalState = undefined;
  }

  async classifyEarlyExit(signal?: AbortSignal): Promise<void> {
    if (this.#exited) return;
    await this.#waitForState(this.#exitWaiters, () => this.#exited, EARLY_EXIT_GRACE_MS, signal);
  }

  async waitForInteraction(yieldMs: number, signal?: AbortSignal): Promise<number> {
    const started = performance.now();
    const deadline = started + yieldMs;
    if (!this.#exited) {
      await this.#waitForState(this.#exitWaiters, () => this.#exited, yieldMs, signal);
    }

    if (this.#exited && !this.#outputClosed) {
      const remaining = Math.max(0, deadline - performance.now());
      const grace = Math.min(POST_EXIT_CLOSE_GRACE_MS, remaining);
      if (grace > 0) await this.#waitForState(this.#closeWaiters, () => this.#outputClosed, grace, signal);
    }
    return Math.max(0, performance.now() - started);
  }

  write(data: string): void {
    if (!this.tty || !this.#pty) throw new Error("stdin is closed for this session; rerun bash with tty=true to keep stdin open");
    this.#pty.write(data);
  }

  resize(size: TerminalSize): void {
    if (!this.tty || !this.#pty || this.#exited) return;
    const normalized = normalizeTerminalSize(size);
    this.#sanitizer.resizeTerminal(normalized.cols, normalized.rows);
    this.#terminalState?.resize(normalized.cols, normalized.rows);
    try {
      this.#pty.resize(normalized.cols, normalized.rows);
    } catch {
      // A PTY can exit between the state check and the native resize call.
    }
  }

  interrupt(): void {
    if (this.#exited) return;
    if (process.platform === "win32") {
      this.#child?.kill("SIGINT");
      return;
    }
    try {
      process.kill(-this.#pid, "SIGINT");
    } catch {
      this.#child?.kill("SIGINT");
      this.#pty?.kill("SIGINT");
    }
  }

  async terminate(): Promise<void> {
    if (this.#terminating) return this.#terminating;
    this.#terminating = this.#terminateTree();
    return this.#terminating;
  }

  async #terminateTree(): Promise<void> {
    if (process.platform === "win32") {
      if (!this.#exited) {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/pid", String(this.#pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("close", () => resolve());
          killer.once("error", () => resolve());
        });
      }
    } else if ((!this.#exited || !this.#outputClosed) && this.#posixGroupExists()) {
      this.#signalPosixGroup("SIGTERM");
      if (!await this.#waitForPosixGroupExit(500)) {
        this.#signalPosixGroup("SIGKILL");
        await this.#waitForPosixGroupExit(500);
      }
    } else if (!this.#exited) {
      this.#child?.kill("SIGTERM");
      this.#pty?.kill("SIGTERM");
      await Promise.race([this.#waitForExit(), delay(500)]);
      if (!this.#exited) {
        this.#child?.kill("SIGKILL");
        this.#pty?.kill("SIGKILL");
      }
    }
    this.#markExited(this.#exitCode);
    await this.#markOutputClosed();
  }

  #posixGroupExists(): boolean {
    try {
      process.kill(-this.#pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  #signalPosixGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.#pid, signal);
    } catch {
      this.#child?.kill(signal);
      this.#pty?.kill(signal);
    }
  }

  async #waitForPosixGroupExit(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (this.#posixGroupExists()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await delay(Math.min(20, remaining));
    }
    return true;
  }

  #armTimeout(timeoutMs: number | undefined): void {
    if (timeoutMs === undefined) return;
    this.#timeoutTimer = setTimeout(() => {
      if (this.#exited) return;
      this.#failure = `Command timed out after ${timeoutMs / 1000} seconds`;
      void this.terminate();
    }, timeoutMs);
  }

  #consumeRaw(chunk: Buffer, stream: OutputStreamId): void {
    // The artifact sees original bytes synchronously in observed callback order;
    // projection is then admitted to bounded turns (giant callbacks share the
    // same stable Buffer instead of making callback-sized copies).
    this.artifact.append(chunk);
    this.#ingestion.accept(chunk, stream);
  }

  #projectRaw(chunk: Buffer, stream: OutputStreamId): void {
    this.#projectDecoded(this.#decoders.write(stream, chunk), stream);
  }

  #endDecodedStream(stream: OutputStreamId): void {
    this.#projectDecoded(this.#decoders.end(stream), stream);
    const framed = this.#framerFor(stream).end();
    this.#projectFrame(framed, stream);
  }

  #projectDecoded(decoded: string, stream: OutputStreamId): void {
    if (!decoded) return;
    this.#projectFrame(this.#framerFor(stream).write(decoded), stream);
  }

  #projectFrame(frame: ReturnType<Ecma48Framer["write"]>, stream: OutputStreamId): void {
    const committed = this.#sanitizer.consume(frame.events);
    if (stream === "pty" && this.#terminalState) {
      this.#terminalState.setSnapshotMode(this.#sanitizer.screenMode);
      const ordinaryTranscriptActive = !this.#sanitizer.fullscreenActive
        && !this.#sanitizer.screenMode
        && (committed.length > 0 || this.#sanitizer.currentLineActive);
      if (ordinaryTranscriptActive) this.#terminalState.discardLastAlternateSnapshot();
      if (frame.terminal) {
        this.#terminalState.write(frame.terminal, {
          publishSnapshot: !this.#sanitizer.synchronizedFrameActive,
          discardLastAlternateSnapshot: ordinaryTranscriptActive,
        });
      }
    }
    this.#pending.pushSnapshot(this.#sanitizer.drainCommittedOutput());
  }

  #framerFor(stream: OutputStreamId): Ecma48Framer {
    let framer = this.#framers.get(stream);
    if (!framer) {
      framer = new Ecma48Framer();
      this.#framers.set(stream, framer);
    }
    return framer;
  }

  #enqueueRemainingSourceEnds(): void {
    for (const stream of this.#expectedStreams) this.#ingestion.endSource(stream);
  }

  #notifyOutput(): void {
    for (const listener of this.#listeners) listener();
  }

  #markExited(code: number | null): void {
    if (this.#exited) return;
    if (this.#timeoutTimer) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = undefined;
    }
    this.#exited = true;
    this.#exitCode = code;
    for (const resolve of this.#exitWaiters) resolve();
    this.#exitWaiters.clear();
  }

  async #markOutputClosed(): Promise<void> {
    if (this.#outputClosed) return;
    this.#outputClosing ??= this.#closeOutput();
    await this.#outputClosing;
  }

  async #closeOutput(): Promise<void> {
    this.#enqueueRemainingSourceEnds();
    await this.#ingestion.finish();
    try {
      await this.#terminalState?.flush();
    } catch (error) {
      this.#failure ??= `Terminal projection failed: ${(error as Error).message ?? String(error)}`;
    }
    this.#pending.pushSnapshot(this.#sanitizer.drainCommittedOutput());
    this.#sanitizer.end();
    this.#terminalState?.setSnapshotMode(this.#sanitizer.screenMode);
    this.#terminalState?.commitSnapshot();
    this.#pending.pushSnapshot(this.#sanitizer.drainCommittedOutput());
    await this.artifact.closeSource();
    this.#outputClosed = true;
    this.#ptyData?.dispose();
    this.#ptyExit?.dispose();
    for (const resolve of this.#closeWaiters) resolve();
    this.#closeWaiters.clear();
    this.#notifyOutput();
  }

  #waitForExit(signal?: AbortSignal): Promise<void> {
    if (this.#exited) return Promise.resolve();
    return this.#wait(this.#exitWaiters, signal);
  }

  #waitForState(
    waiters: Set<() => void>,
    isDone: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (isDone()) return Promise.resolve(true);
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const changed = () => finish(true);
      const aborted = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(changed);
        signal?.removeEventListener("abort", aborted);
      };
      const finish = (value: boolean) => {
        cleanup();
        resolve(value);
      };
      waiters.add(changed);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  #wait(waiters: Set<() => void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", aborted);
        waiters.delete(done);
        resolve();
      };
      const aborted = () => {
        waiters.delete(done);
        reject(abortError());
      };
      waiters.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }
}
