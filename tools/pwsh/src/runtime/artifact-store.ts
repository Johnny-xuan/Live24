import { rmSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ARTIFACT_IO_TIMEOUT_MS,
  ARTIFACT_MANAGER_MAX_BYTES,
  ARTIFACT_PROCESS_MAX_BYTES,
  ARTIFACT_WRITE_HIGH_WATER_BYTES,
  ARTIFACT_WRITE_LOW_WATER_BYTES,
} from "../constants.js";
import type { OutputArtifactDetails } from "../protocol.js";
import { secureWindowsDirectory, verifyWindowsAcl } from "./windows-acl.js";

const ARTIFACT_ROOT_PREFIX = "pwsh-";
const ARTIFACT_OWNER_FILE = ".owner.json";
const ARTIFACT_RANDOM_ROOT = /^pwsh-[A-Za-z0-9_-]{6}$/;

function ownerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function cleanupStaleWindowsArtifactRoots(tempRoot: string): Promise<void> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  await Promise.allSettled(entries.map(async (entry) => {
    if (!entry.isDirectory() || !ARTIFACT_RANDOM_ROOT.test(entry.name)) return;
    const root = path.join(tempRoot, entry.name);
    const info = await lstat(root).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    const ownerPath = path.join(root, ARTIFACT_OWNER_FILE);
    let owner: { version?: unknown; pid?: unknown };
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8")) as { version?: unknown; pid?: unknown };
    } catch {
      return;
    }
    const pid = Number(owner.pid);
    if (owner.version !== 1 || !Number.isSafeInteger(pid) || pid <= 0) return;
    if (pid === process.pid || ownerProcessAlive(pid)) return;
    if (!verifyWindowsAcl(root).secure || !verifyWindowsAcl(ownerPath).secure) return;
    await rm(root, { recursive: true, force: true });
  }));
}

export class ArtifactStore {
  readonly root: string | undefined;
  readonly processLimit: number;
  readonly managerLimit: number;
  readonly enabled: boolean;
  readonly securityIssue: "unsafe_permissions" | "unsafe_acl" | undefined;
  readonly ioTimeoutMs: number;
  #usedBytes = 0;
  #spools = new Set<ArtifactSpool>();
  #closed = false;
  #shutdownPromise?: Promise<void>;
  #exitCleanup: (() => void) | undefined;
  readonly #closeFile: (handle: FileHandle) => Promise<void>;

  private constructor(
    root: string | undefined,
    processLimit: number,
    managerLimit: number,
    enabled: boolean,
    securityIssue: "unsafe_permissions" | "unsafe_acl" | undefined,
    closeFile: (handle: FileHandle) => Promise<void>,
    ioTimeoutMs: number,
  ) {
    this.root = root;
    this.processLimit = processLimit;
    this.managerLimit = managerLimit;
    this.enabled = enabled;
    this.securityIssue = securityIssue;
    this.#closeFile = closeFile;
    this.ioTimeoutMs = Math.max(1, ioTimeoutMs);
    if (root) {
      this.#exitCleanup = () => {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort during process exit */ }
      };
      process.once("exit", this.#exitCleanup);
    }
  }

  static async create(options: {
    processLimit?: number;
    managerLimit?: number;
    platform?: NodeJS.Platform;
    closeFile?: (handle: FileHandle) => Promise<void>;
    ioTimeoutMs?: number;
  } = {}): Promise<ArtifactStore> {
    const processLimit = options.processLimit ?? ARTIFACT_PROCESS_MAX_BYTES;
    const managerLimit = options.managerLimit ?? ARTIFACT_MANAGER_MAX_BYTES;
    const platform = options.platform ?? process.platform;
    const closeFile = options.closeFile ?? ((handle: FileHandle) => handle.close());
    const ioTimeoutMs = options.ioTimeoutMs ?? ARTIFACT_IO_TIMEOUT_MS;
    const build = (
      root: string | undefined,
      enabled: boolean,
      securityIssue?: "unsafe_permissions" | "unsafe_acl",
    ) => new ArtifactStore(root, processLimit, managerLimit, enabled, securityIssue, closeFile, ioTimeoutMs);
    if (platform === "win32") {
      if (process.platform !== "win32") return build(undefined, false, "unsafe_acl");
      let root: string | undefined;
      try {
        await cleanupStaleWindowsArtifactRoots(os.tmpdir());
        root = await mkdtemp(path.join(os.tmpdir(), ARTIFACT_ROOT_PREFIX));
        const verification = secureWindowsDirectory(root);
        if (!verification.secure) {
          await rm(root, { recursive: true, force: true });
          return build(undefined, false, "unsafe_acl");
        }
        const probePath = path.join(root, ".acl-inheritance-probe");
        const probe = await open(probePath, "wx", 0o600);
        await probe.close();
        const inherited = verifyWindowsAcl(probePath);
        await unlink(probePath).catch(() => undefined);
        if (!inherited.secure) {
          await rm(root, { recursive: true, force: true });
          return build(undefined, false, "unsafe_acl");
        }
        const ownerPath = path.join(root, ARTIFACT_OWNER_FILE);
        await writeFile(ownerPath, JSON.stringify({ version: 1, pid: process.pid, created_at: new Date().toISOString() }), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        if (!verifyWindowsAcl(ownerPath).secure) {
          await rm(root, { recursive: true, force: true });
          return build(undefined, false, "unsafe_acl");
        }
        return build(root, true);
      } catch {
        if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
        return build(undefined, false, "unsafe_acl");
      }
    }
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), "pwsh-"));
      await chmod(root, 0o700);
      const mode = (await stat(root)).mode & 0o777;
      if (mode !== 0o700) {
        await rm(root, { recursive: true, force: true });
        return build(undefined, false, "unsafe_permissions");
      }
      return build(root, true);
    } catch {
      return build(undefined, false, "unsafe_permissions");
    }
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  closeFile(handle: FileHandle): Promise<void> {
    return this.#closeFile(handle);
  }

  async runIo<T>(operation: () => Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${this.ioTimeoutMs}ms`)), this.ioTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async createSpool(processId: number): Promise<ArtifactSpool> {
    if (this.#closed) throw new Error("artifact store is closed");
    if (!this.enabled || !this.root) {
      const spool = ArtifactSpool.unavailable(this);
      this.#spools.add(spool);
      return spool;
    }
    const filePath = path.join(this.root, `${processId}.log`);
    let handle: FileHandle;
    try {
      handle = await this.runIo(() => open(filePath, "wx", 0o600), "artifact open");
      if (this.#closed) {
        await this.runIo(() => this.closeFile(handle), "artifact close").catch(() => undefined);
        await unlink(filePath).catch(() => undefined);
        throw new Error("artifact store is closed");
      }
    } catch (error) {
      if (this.#closed) throw error;
      const spool = ArtifactSpool.unavailable(this);
      this.#spools.add(spool);
      return spool;
    }
    const spool = new ArtifactSpool(this, filePath, handle);
    this.#spools.add(spool);
    return spool;
  }

  reserve(spool: ArtifactSpool, requested: number): number {
    if (this.#closed || spool.sealed || spool.unavailable) return 0;
    const processRemaining = Math.max(0, this.processLimit - spool.bytesWritten);
    const managerRemaining = Math.max(0, this.managerLimit - this.#usedBytes);
    const granted = Math.min(requested, processRemaining, managerRemaining);
    this.#usedBytes += granted;
    return granted;
  }

  release(bytes: number): void {
    this.#usedBytes = Math.max(0, this.#usedBytes - bytes);
  }

  forget(spool: ArtifactSpool): void {
    this.#spools.delete(spool);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#closed = true;
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
  }

  async #finishShutdown(): Promise<void> {
    if (this.#exitCleanup) {
      process.off("exit", this.#exitCleanup);
      this.#exitCleanup = undefined;
    }
    await Promise.allSettled(Array.from(this.#spools, (spool) => spool.remove()));
    this.#spools.clear();
    this.#usedBytes = 0;
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}

export class ArtifactSpool {
  readonly path: string;
  readonly highWaterBytes = ARTIFACT_WRITE_HIGH_WATER_BYTES;
  readonly lowWaterBytes = ARTIFACT_WRITE_LOW_WATER_BYTES;
  bytesWritten = 0;
  omittedBytes = 0;
  sealed = false;
  unavailable = false;
  exposed = false;
  sourceClosed = false;
  #store: ArtifactStore;
  #handle: FileHandle | undefined;
  #writeQueue: Buffer[] = [];
  #writeQueueOffset = 0;
  #building?: { data: Buffer; end: number };
  #pump?: Promise<void>;
  #persistedBytes = 0;
  #pendingBytes = 0;
  #flushWaiters: Array<{ targetBytes: number; resolve(): void }> = [];
  #pressureListeners = new Set<() => void>();
  #closing?: Promise<void>;
  #removed = false;

  constructor(store: ArtifactStore, filePath: string, handle: FileHandle | undefined) {
    this.#store = store;
    this.path = filePath;
    this.#handle = handle;
  }

  static unavailable(store: ArtifactStore): ArtifactSpool {
    const spool = new ArtifactSpool(store, "", undefined);
    spool.#handle = undefined;
    spool.unavailable = true;
    spool.sealed = true;
    return spool;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  subscribePressure(listener: () => void): () => void {
    this.#pressureListeners.add(listener);
    return () => this.#pressureListeners.delete(listener);
  }

  append(chunk: Buffer): void {
    if (this.#removed || this.sourceClosed || chunk.length === 0) return;
    if (this.unavailable || this.sealed) {
      this.omittedBytes += chunk.length;
      return;
    }

    const granted = this.#store.reserve(this, chunk.length);
    this.bytesWritten += granted;
    if (granted < chunk.length) {
      this.sealed = true;
      this.omittedBytes += chunk.length - granted;
    }
    if (granted === 0) return;

    // An unexpectedly large native callback is already an owned immutable
    // Buffer. Queue one view instead of making a second callback-sized copy;
    // the pump still writes it in bounded quanta below.
    if (granted > this.lowWaterBytes) {
      this.#sealBuildingSlab();
      this.#writeQueue.push(chunk.subarray(0, granted));
      this.#pendingBytes += granted;
      this.#notifyPressure();
      this.#startPump();
      return;
    }

    let offset = 0;
    while (offset < granted) {
      this.#building ??= { data: Buffer.allocUnsafe(this.lowWaterBytes), end: 0 };
      const accepted = Math.min(granted - offset, this.#building.data.length - this.#building.end);
      chunk.copy(this.#building.data, this.#building.end, offset, offset + accepted);
      this.#building.end += accepted;
      offset += accepted;
      this.#pendingBytes += accepted;
      if (this.#building.end === this.#building.data.length) this.#sealBuildingSlab();
    }
    this.#notifyPressure();
    this.#startPump();
  }

  async flush(): Promise<void> {
    const targetBytes = this.bytesWritten;
    if (this.unavailable || this.#persistedBytes >= targetBytes) return;
    this.#sealBuildingSlab();
    this.#startPump();
    return new Promise((resolve) => {
      this.#flushWaiters.push({ targetBytes, resolve });
    });
  }

  closeSource(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#finishCloseSource();
    return this.#closing;
  }

  async #finishCloseSource(): Promise<void> {
    this.sourceClosed = true;
    await this.flush();
    if (this.#handle) {
      try {
        await this.#closeHandle(1);
      } catch {
        await this.#markUnavailable();
      }
    }
  }

  expose(): OutputArtifactDetails | "unavailable" {
    this.exposed = true;
    if (this.unavailable) return "unavailable";
    return this.details();
  }

  details(): OutputArtifactDetails {
    return {
      path: this.path,
      complete: this.sourceClosed && this.#handle === undefined && this.omittedBytes === 0 && !this.unavailable,
      bytes_written: this.bytesWritten,
      omitted_bytes: this.omittedBytes,
    };
  }

  async remove(): Promise<void> {
    if (this.#removed) return;
    this.#removed = true;
    await this.flush().catch(() => undefined);
    if (this.#handle) await this.#closeHandle().catch(() => undefined);
    if (this.path) await unlink(this.path).catch(() => undefined);
    this.#store.release(this.bytesWritten);
    this.bytesWritten = 0;
    this.#pressureListeners.clear();
    this.#store.forget(this);
  }

  writeStats(): { pendingBytes: number; queuedSlabs: number; pumpActive: boolean } {
    return {
      pendingBytes: this.#pendingBytes,
      queuedSlabs: this.#writeQueue.length - this.#writeQueueOffset + (this.#building ? 1 : 0),
      pumpActive: this.#pump !== undefined,
    };
  }

  async #closeHandle(attempts = 2): Promise<void> {
    const handle = this.#handle;
    if (!handle) return;
    let failure: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.#store.runIo(() => this.#store.closeFile(handle), "artifact close");
        this.#handle = undefined;
        return;
      } catch (error) {
        failure = error;
        if (attempt + 1 < attempts) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    throw failure;
  }

  #sealBuildingSlab(): void {
    if (!this.#building || this.#building.end === 0) return;
    this.#writeQueue.push(this.#building.data.subarray(0, this.#building.end));
    this.#building = undefined;
  }

  #startPump(): void {
    if (this.#pump || this.unavailable || !this.#handle) return;
    this.#pump = this.#pumpWrites().finally(() => {
      this.#pump = undefined;
      if (!this.unavailable && (this.#building || this.#writeQueueOffset < this.#writeQueue.length)) {
        this.#startPump();
      }
    });
  }

  async #pumpWrites(): Promise<void> {
    while (!this.unavailable && this.#handle) {
      this.#sealBuildingSlab();
      const bytes = this.#writeQueue[this.#writeQueueOffset];
      if (!bytes) return;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const end = Math.min(bytes.length, offset + this.lowWaterBytes);
          const handle = this.#handle;
          if (!handle) throw new Error("artifact handle closed during write");
          const result = await this.#store.runIo(
            () => handle.write(bytes.subarray(offset, end)),
            "artifact write",
          );
          if (result.bytesWritten <= 0) throw new Error("artifact write made no progress");
          offset += result.bytesWritten;
        }
      } catch {
        await this.#markUnavailable();
        return;
      }
      this.#writeQueueOffset += 1;
      this.#persistedBytes += bytes.length;
      this.#pendingBytes = Math.max(0, this.#pendingBytes - bytes.length);
      if (this.#writeQueueOffset >= 64 && this.#writeQueueOffset * 2 >= this.#writeQueue.length) {
        this.#writeQueue = this.#writeQueue.slice(this.#writeQueueOffset);
        this.#writeQueueOffset = 0;
      }
      this.#resolveFlushWaiters();
      this.#notifyPressure();
    }
  }

  #resolveFlushWaiters(): void {
    if (this.#flushWaiters.length === 0) return;
    const pending: Array<{ targetBytes: number; resolve(): void }> = [];
    for (const waiter of this.#flushWaiters) {
      if (this.unavailable || waiter.targetBytes <= this.#persistedBytes) waiter.resolve();
      else pending.push(waiter);
    }
    this.#flushWaiters = pending;
  }

  #notifyPressure(): void {
    for (const listener of this.#pressureListeners) listener();
  }

  async #markUnavailable(): Promise<void> {
    if (this.unavailable) return;
    this.unavailable = true;
    this.sealed = true;
    if (this.#handle) await this.#closeHandle().catch(() => undefined);
    if (this.path) await unlink(this.path).catch(() => undefined);
    // The artifact no longer contains any recoverable bytes. Preserve the
    // accounting identity for all raw bytes observed before the failure.
    this.omittedBytes += this.bytesWritten;
    this.#store.release(this.bytesWritten);
    this.bytesWritten = 0;
    this.#building = undefined;
    this.#writeQueue.length = 0;
    this.#writeQueueOffset = 0;
    this.#pendingBytes = 0;
    this.#resolveFlushWaiters();
    this.#notifyPressure();
  }
}
