import { performance } from "node:perf_hooks";
import {
  OUTPUT_DRAIN_MAX_BYTES,
  OUTPUT_DRAIN_TARGET_MS,
  OUTPUT_QUEUE_HIGH_WATER_BYTES,
  OUTPUT_QUEUE_LOW_WATER_BYTES,
  RAW_READ_MAX_BYTES,
} from "../constants.js";

export interface OutputSourceControl {
  pause(): void;
  resume(): void;
}

export interface OutputPressureSource {
  readonly pendingBytes: number;
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
  subscribePressure(listener: () => void): () => void;
}

export type OutputStreamId = "output" | "stdout" | "stderr" | "pty";

export interface OutputIngestionOptions {
  consume(chunk: Buffer, stream: OutputStreamId): void;
  onSourceEnd?: (stream: OutputStreamId) => void;
  onTurn?: () => void;
  onConsumeError?: (error: unknown) => void;
  pressures?: OutputPressureSource[];
  chunkBytes?: number;
  turnBytes?: number;
  turnTargetMs?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
}

interface QueueSlab {
  kind: "data";
  /** Giant homogeneous callbacks retain one shared view and need no tag table. */
  stream?: OutputStreamId;
  /** Normal fixed slabs preserve cross-stream callback order with one byte tag per data byte. */
  streamTags?: Uint8Array;
  data: Buffer;
  start: number;
  end: number;
}

interface QueueEnd {
  kind: "end";
  stream: OutputStreamId;
}

type QueueEntry = QueueSlab | QueueEnd;

const STREAM_IDS: OutputStreamId[] = ["output", "stdout", "stderr", "pty"];

function streamTag(stream: OutputStreamId): number {
  return STREAM_IDS.indexOf(stream);
}

function taggedStream(tag: number): OutputStreamId {
  const stream = STREAM_IDS[tag];
  if (!stream) throw new Error(`Unknown output stream tag ${tag}`);
  return stream;
}

interface DrainWaiter {
  targetUnits: number;
  resolve(): void;
}

/**
 * Bounded-turn bridge between push-style child output and synchronous
 * projection. It coalesces arbitrary tiny callbacks into fixed-size slabs,
 * owns source pause/resume, and yields through setImmediate between turns.
 */
export class OutputIngestionController {
  readonly #consume: (chunk: Buffer, stream: OutputStreamId) => void;
  readonly #onSourceEnd?: (stream: OutputStreamId) => void;
  readonly #onTurn?: () => void;
  readonly #onConsumeError?: (error: unknown) => void;
  readonly #pressures: OutputPressureSource[];
  readonly #chunkBytes: number;
  readonly #turnBytes: number;
  readonly #turnTargetMs: number;
  readonly #highWaterBytes: number;
  readonly #lowWaterBytes: number;
  readonly #pressureDisposers: Array<() => void>;

  #source?: OutputSourceControl;
  #queue: QueueEntry[] = [];
  #queueOffset = 0;
  #queuedBytes = 0;
  #acceptedUnits = 0;
  #processedUnits = 0;
  #scheduled?: NodeJS.Immediate;
  #sourcePaused = false;
  #ending = false;
  #disposed = false;
  #endedStreams = new Set<OutputStreamId>();
  #drainWaiters: DrainWaiter[] = [];

  constructor(options: OutputIngestionOptions) {
    this.#consume = options.consume;
    this.#onSourceEnd = options.onSourceEnd;
    this.#onTurn = options.onTurn;
    this.#onConsumeError = options.onConsumeError;
    this.#pressures = options.pressures ?? [];
    this.#chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? RAW_READ_MAX_BYTES));
    this.#turnBytes = Math.max(this.#chunkBytes, Math.floor(options.turnBytes ?? OUTPUT_DRAIN_MAX_BYTES));
    this.#turnTargetMs = Math.max(1, options.turnTargetMs ?? OUTPUT_DRAIN_TARGET_MS);
    this.#highWaterBytes = Math.max(this.#chunkBytes, Math.floor(options.highWaterBytes ?? OUTPUT_QUEUE_HIGH_WATER_BYTES));
    this.#lowWaterBytes = Math.min(
      this.#highWaterBytes,
      Math.max(0, Math.floor(options.lowWaterBytes ?? OUTPUT_QUEUE_LOW_WATER_BYTES)),
    );
    this.#pressureDisposers = this.#pressures.map((pressure) => pressure.subscribePressure(() => {
      if (this.#disposed) return;
      this.#updateSourceFlow();
      if (this.#queuedBytes > 0 && !this.#sinkBlocked()) this.#schedule();
    }));
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get paused(): boolean {
    return this.#sourcePaused;
  }

  queueStats(): { queuedBytes: number; queuedEntries: number } {
    return {
      queuedBytes: this.#queuedBytes,
      queuedEntries: Math.max(0, this.#queue.length - this.#queueOffset),
    };
  }

  setSource(source: OutputSourceControl): void {
    this.#source = source;
    this.#updateSourceFlow();
  }

  accept(chunk: Buffer, stream: OutputStreamId = "output"): void {
    if (this.#disposed || this.#ending || this.#endedStreams.has(stream) || chunk.length === 0) return;

    // Normal callbacks are copied into fixed slabs. A callback larger than the
    // queue watermark is the allowed one-callback overshoot: retain its Buffer
    // once and drain bounded views instead of creating another full-size copy.
    if (chunk.length > this.#highWaterBytes) {
      this.#queue.push({ kind: "data", stream, data: chunk, start: 0, end: chunk.length });
      this.#queuedBytes += chunk.length;
      this.#acceptedUnits += chunk.length;
      this.#updateSourceFlow();
      this.#schedule();
      return;
    }

    let offset = 0;
    const tag = streamTag(stream);
    while (offset < chunk.length) {
      let slab = this.#lastSlab();
      if (!slab || slab.end === slab.data.length) {
        slab = {
          kind: "data",
          data: Buffer.allocUnsafe(this.#chunkBytes),
          streamTags: new Uint8Array(this.#chunkBytes),
          start: 0,
          end: 0,
        };
        this.#queue.push(slab);
      }
      const accepted = Math.min(chunk.length - offset, slab.data.length - slab.end);
      chunk.copy(slab.data, slab.end, offset, offset + accepted);
      slab.streamTags!.fill(tag, slab.end, slab.end + accepted);
      slab.end += accepted;
      offset += accepted;
      this.#queuedBytes += accepted;
      this.#acceptedUnits += accepted;
    }
    this.#updateSourceFlow();
    this.#schedule();
  }

  endSource(stream: OutputStreamId = "output"): void {
    if (this.#disposed || this.#ending || this.#endedStreams.has(stream)) return;
    this.#endedStreams.add(stream);
    this.#queue.push({ kind: "end", stream });
    this.#acceptedUnits += 1;
    this.#schedule();
  }

  async flush(): Promise<void> {
    const targetUnits = this.#acceptedUnits;
    if (this.#processedUnits >= targetUnits) return;
    return new Promise((resolve) => {
      this.#drainWaiters.push({ targetUnits, resolve });
      this.#schedule();
    });
  }

  async finish(): Promise<void> {
    if (this.#disposed) return;
    this.#ending = true;
    this.#updateSourceFlow();
    await this.flush();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#scheduled) clearImmediate(this.#scheduled);
    this.#scheduled = undefined;
    for (const dispose of this.#pressureDisposers) dispose();
    this.#queue.length = 0;
    this.#queueOffset = 0;
    this.#queuedBytes = 0;
    this.#processedUnits = this.#acceptedUnits;
    this.#resolveDrainWaiters();
  }

  #schedule(): void {
    if (this.#disposed || this.#scheduled || !this.#hasQueuedEntries() || this.#sinkBlocked()) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      this.#drainTurn();
    });
  }

  #drainTurn(): void {
    if (this.#disposed) return;
    const started = performance.now();
    let processedBytes = 0;
    let processedEntries = 0;
    while (
      this.#hasQueuedEntries()
      && processedBytes < this.#turnBytes
      && !this.#sinkBlocked()
    ) {
      const entry = this.#queue[this.#queueOffset]!;
      if (entry.kind === "end") {
        try {
          this.#onSourceEnd?.(entry.stream);
        } catch (error) {
          this.#onConsumeError?.(error);
        }
        this.#processedUnits += 1;
        this.#queueOffset += 1;
        processedEntries += 1;
      } else {
        const limit = Math.min(entry.end, entry.start + this.#turnBytes - processedBytes, entry.start + this.#chunkBytes);
        const stream = entry.stream ?? taggedStream(entry.streamTags![entry.start]!);
        let runEnd = limit;
        if (!entry.stream) {
          const tag = entry.streamTags![entry.start]!;
          runEnd = entry.start + 1;
          while (runEnd < limit && entry.streamTags![runEnd] === tag) runEnd += 1;
        }
        const accepted = runEnd - entry.start;
        const part = entry.data.subarray(entry.start, runEnd);
        try {
          this.#consume(part, stream);
        } catch (error) {
          this.#onConsumeError?.(error);
        }
        entry.start = runEnd;
        processedBytes += accepted;
        this.#queuedBytes -= accepted;
        this.#processedUnits += accepted;
        if (entry.start === entry.end) {
          this.#queueOffset += 1;
          processedEntries += 1;
        }
      }
      if (processedEntries > 0 && performance.now() - started >= this.#turnTargetMs) break;
    }

    if (this.#queueOffset > 0 && (this.#queueOffset >= 64 || this.#queueOffset * 2 >= this.#queue.length)) {
      this.#queue = this.#queue.slice(this.#queueOffset);
      this.#queueOffset = 0;
    }

    if (processedBytes > 0 || processedEntries > 0) this.#onTurn?.();
    this.#resolveDrainWaiters();
    this.#updateSourceFlow();
    if (!this.#hasQueuedEntries()) {
      this.#queue.length = 0;
      this.#queueOffset = 0;
      this.#resolveDrainWaiters();
      return;
    }
    this.#schedule();
  }

  #hasQueuedEntries(): boolean {
    return this.#queueOffset < this.#queue.length;
  }

  #lastSlab(): QueueSlab | undefined {
    if (!this.#hasQueuedEntries()) return undefined;
    const entry = this.#queue[this.#queue.length - 1];
    return entry?.kind === "data" && entry.streamTags ? entry : undefined;
  }

  #sinkBlocked(): boolean {
    return this.#pressures.some((pressure) => pressure.pendingBytes >= pressure.highWaterBytes);
  }

  #belowAllLowWater(): boolean {
    return this.#queuedBytes <= this.#lowWaterBytes
      && this.#pressures.every((pressure) => pressure.pendingBytes <= pressure.lowWaterBytes);
  }

  #updateSourceFlow(): void {
    if (!this.#source) return;
    const shouldPause = this.#ending
      || this.#queuedBytes >= this.#highWaterBytes
      || this.#sinkBlocked();
    if (shouldPause && !this.#sourcePaused) {
      this.#sourcePaused = true;
      try {
        this.#source.pause();
      } catch {
        // Source exit can race pressure changes.
      }
      return;
    }
    if (!shouldPause && this.#sourcePaused && this.#belowAllLowWater()) {
      this.#sourcePaused = false;
      try {
        this.#source.resume();
      } catch {
        // Source exit can race pressure changes.
      }
    }
  }

  #resolveDrainWaiters(): void {
    if (this.#drainWaiters.length === 0) return;
    const pending: DrainWaiter[] = [];
    for (const waiter of this.#drainWaiters) {
      if (waiter.targetUnits <= this.#processedUnits) waiter.resolve();
      else pending.push(waiter);
    }
    this.#drainWaiters = pending;
  }
}
