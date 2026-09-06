import { chmod, mkdtemp, open, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ARTIFACT_MANAGER_MAX_BYTES,
  ARTIFACT_PROCESS_MAX_BYTES,
  ARTIFACT_WRITE_HIGH_WATER_BYTES,
  ARTIFACT_WRITE_LOW_WATER_BYTES,
} from "../constants.js";
import type { OutputArtifactDetails } from "../protocol.js";

export class ArtifactStore {
  readonly root: string | undefined;
  readonly processLimit: number;
  readonly managerLimit: number;
  readonly enabled: boolean;
  #usedBytes = 0;
  #spools = new Set<ArtifactSpool>();
  #closed = false;

  private constructor(root: string | undefined, processLimit: number, managerLimit: number, enabled: boolean) {
    this.root = root;
    this.processLimit = processLimit;
    this.managerLimit = managerLimit;
    this.enabled = enabled;
  }

  static async create(options: { processLimit?: number; managerLimit?: number; platform?: NodeJS.Platform } = {}): Promise<ArtifactStore> {
    const processLimit = options.processLimit ?? ARTIFACT_PROCESS_MAX_BYTES;
    const managerLimit = options.managerLimit ?? ARTIFACT_MANAGER_MAX_BYTES;
    const platform = options.platform ?? process.platform;
    // Windows artifacts remain disabled until the ACL doctor can prove the v1 contract.
    if (platform === "win32") return new ArtifactStore(undefined, processLimit, managerLimit, false);
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), "pi-bash-"));
      await chmod(root, 0o700);
      const mode = (await stat(root)).mode & 0o777;
      if (mode !== 0o700) {
        await rm(root, { recursive: true, force: true });
        return new ArtifactStore(undefined, processLimit, managerLimit, false);
      }
      return new ArtifactStore(root, processLimit, managerLimit, true);
    } catch {
      return new ArtifactStore(undefined, processLimit, managerLimit, false);
    }
  }

  get usedBytes(): number {
    return this.#usedBytes;
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
      handle = await open(filePath, "wx", 0o600);
    } catch {
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

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
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

  async closeSource(): Promise<void> {
    if (this.sourceClosed) return;
    this.sourceClosed = true;
    await this.flush();
    if (this.#handle) {
      await this.#handle.close().catch(() => undefined);
      this.#handle = undefined;
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
      complete: this.sourceClosed && this.omittedBytes === 0 && !this.unavailable,
      bytes_written: this.bytesWritten,
      omitted_bytes: this.omittedBytes,
    };
  }

  async remove(): Promise<void> {
    if (this.#removed) return;
    this.#removed = true;
    await this.flush().catch(() => undefined);
    if (this.#handle) {
      await this.#handle.close().catch(() => undefined);
      this.#handle = undefined;
    }
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
          const result = await this.#handle.write(bytes.subarray(offset, end));
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
    if (this.#handle) {
      await this.#handle.close().catch(() => undefined);
      this.#handle = undefined;
    }
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
