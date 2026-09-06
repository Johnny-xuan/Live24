import type { OutputSnapshot } from "./head-tail-buffer.js";
import { nextSafeBufferBoundary, sgrSequenceEnd } from "./ansi-boundary.js";
import { materializeOutputSnapshot } from "./presenter.js";

const DEFAULT_SLAB_BYTES = 8 * 1024;
const MAX_SAFE_TOKEN_BYTES = 64;

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Largest prefix no greater than budget that ends on a UTF-8 boundary. */
function prefixBytesWithin(bytes: Buffer, offset: number, budget: number): number {
  const available = bytes.length - offset;
  if (available <= budget) return available;
  let length = Math.max(0, budget);
  while (length > 0 && isUtf8Continuation(bytes[offset + length]!)) length -= 1;
  return length;
}

/**
 * Byte-native storage for a stable prefix and rolling suffix.
 *
 * Input must already be valid, normalized Unicode. The fixed slot table and
 * reusable slabs prevent retained metadata from depending on source chunk
 * count. The oldest slab may advance within its payload, but only to a UTF-8
 * boundary. The structured transcript layer identifies bounded SGR tokens and
 * submits them through pushSafeToken; snapshot reload/clone replays those
 * already-framed tokens atomically and never parses raw terminal input.
 */
export class SafeSlabStore {
  readonly maxBytes: number;
  readonly slabBytes: number;

  readonly #headBudget: number;
  readonly #head: Buffer;
  readonly #slots: Array<Buffer | undefined>;
  readonly #starts: Uint32Array;
  readonly #ends: Uint32Array;

  #headBytes = 0;
  #headSealed = false;
  #tailBudget = 0;
  #firstSlot = 0;
  #slotCount = 0;
  #tailBytes = 0;
  #totalBytes = 0;

  constructor(maxBytes: number, slabBytes = DEFAULT_SLAB_BYTES) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.slabBytes = Math.max(MAX_SAFE_TOKEN_BYTES, Math.floor(slabBytes));
    this.#headBudget = Math.floor(this.maxBytes / 2);
    this.#head = Buffer.allocUnsafe(this.#headBudget);

    const minimumPayload = Math.max(1, this.slabBytes - (MAX_SAFE_TOKEN_BYTES - 1));
    const minimumHead = this.#headBudget >= MAX_SAFE_TOKEN_BYTES
      ? this.#headBudget - (MAX_SAFE_TOKEN_BYTES - 1)
      : 0;
    const maximumTail = Math.max(0, this.maxBytes - minimumHead);
    const slotCapacity = Math.max(1, Math.ceil(maximumTail / minimumPayload) + 1);
    this.#slots = new Array<Buffer | undefined>(slotCapacity);
    this.#starts = new Uint32Array(slotCapacity);
    this.#ends = new Uint32Array(slotCapacity);
  }

  push(text: string): void {
    if (!text) return;
    // Bound temporary encoding independently of caller string length. A chunk
    // end never separates a UTF-16 surrogate pair.
    const codeUnitQuantum = Math.max(1, Math.floor(this.slabBytes / 3));
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + codeUnitQuantum);
      if (
        end < text.length
        && end > start
        && text.charCodeAt(end - 1) >= 0xd800
        && text.charCodeAt(end - 1) <= 0xdbff
        && text.charCodeAt(end) >= 0xdc00
        && text.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1;
      }
      const encoded = Buffer.from(text.slice(start, end), "utf8");
      this.#totalBytes += encoded.length;
      this.#appendValidUtf8(encoded);
      start = end;
    }
    this.#trimTail();
  }

  /** Appends one already-framed control token without allowing slab splits. */
  pushSafeToken(text: string): void {
    if (!text) return;
    const encoded = Buffer.from(text, "utf8");
    if (encoded.length > MAX_SAFE_TOKEN_BYTES) {
      throw new Error(`safe token exceeds ${MAX_SAFE_TOKEN_BYTES} bytes`);
    }
    this.#totalBytes += encoded.length;
    this.#appendAtomic(encoded);
    this.#trimTail();
  }

  snapshot(): OutputSnapshot {
    const head = this.#head.subarray(0, this.#headBytes).toString("utf8");
    const tail = this.#tailString();
    const retainedBytes = this.#headBytes + this.#tailBytes;
    const omittedBytes = this.#totalBytes - retainedBytes;
    const snapshot: OutputSnapshot = omittedBytes === 0
      ? {
          head: `${head}${tail}`,
          tail: "",
          omittedBytes: 0,
          totalBytes: this.#totalBytes,
          materialized: "",
        }
      : {
          head,
          tail,
          omittedBytes,
          totalBytes: this.#totalBytes,
          materialized: "",
        };
    snapshot.materialized = materializeOutputSnapshot(snapshot);
    return snapshot;
  }

  loadSnapshot(snapshot: OutputSnapshot): void {
    this.clear();
    if (snapshot.totalBytes === 0) return;
    if (snapshot.omittedBytes === 0) {
      this.#pushSnapshotText(snapshot.materialized);
      return;
    }

    const head = Buffer.from(snapshot.head, "utf8");
    if (head.length > this.#headBudget) {
      throw new Error("snapshot head exceeds stable head budget");
    }
    head.copy(this.#head, 0);
    this.#headBytes = head.length;
    this.#headSealed = true;
    this.#tailBudget = Math.max(0, this.maxBytes - this.#headBytes);

    this.#appendSnapshotTail(snapshot.tail);
    this.#totalBytes = snapshot.totalBytes;
    this.#trimTail();
  }

  clone(): SafeSlabStore {
    const copy = new SafeSlabStore(this.maxBytes, this.slabBytes);
    copy.loadSnapshot(this.snapshot());
    return copy;
  }

  clear(): void {
    this.#headBytes = 0;
    this.#headSealed = false;
    this.#tailBudget = 0;
    for (let logical = 0; logical < this.#slotCount; logical += 1) {
      const index = this.#slotIndex(logical);
      this.#starts[index] = 0;
      this.#ends[index] = 0;
    }
    this.#firstSlot = 0;
    this.#slotCount = 0;
    this.#tailBytes = 0;
    this.#totalBytes = 0;
  }

  /** Bounded structural evidence for tests and diagnostics, never payload. */
  storageStats(): {
    slotCapacity: number;
    allocatedSlabs: number;
    allocatedPayloadBytes: number;
    retainedBytes: number;
  } {
    const allocatedSlabs = this.#slots.reduce((count, slab) => count + (slab ? 1 : 0), 0);
    return {
      slotCapacity: this.#slots.length,
      allocatedSlabs,
      allocatedPayloadBytes: this.#head.length + allocatedSlabs * this.slabBytes,
      retainedBytes: this.#headBytes + this.#tailBytes,
    };
  }

  #appendValidUtf8(bytes: Buffer): void {
    let offset = 0;
    if (!this.#headSealed) {
      const available = this.#headBudget - this.#headBytes;
      const accepted = prefixBytesWithin(bytes, offset, available);
      if (accepted > 0) {
        bytes.copy(this.#head, this.#headBytes, offset, offset + accepted);
        this.#headBytes += accepted;
        offset += accepted;
      }
      if (offset < bytes.length) {
        this.#headSealed = true;
        this.#tailBudget = Math.max(0, this.maxBytes - this.#headBytes);
      }
    }
    if (offset < bytes.length) this.#appendTail(bytes.subarray(offset));
  }

  #pushSnapshotText(text: string): void {
    let index = 0;
    let plainStart = 0;
    while (index < text.length) {
      const end = sgrSequenceEnd(text, index);
      if (end === undefined) {
        index += 1;
        continue;
      }
      if (index > plainStart) this.push(text.slice(plainStart, index));
      this.pushSafeToken(text.slice(index, end));
      index = end;
      plainStart = end;
    }
    if (plainStart < text.length) this.push(text.slice(plainStart));
  }

  #appendSnapshotTail(text: string): void {
    let index = 0;
    let plainStart = 0;
    while (index < text.length) {
      const end = sgrSequenceEnd(text, index);
      if (end === undefined) {
        index += 1;
        continue;
      }
      if (index > plainStart) this.#appendTail(Buffer.from(text.slice(plainStart, index), "utf8"));
      this.#appendAtomic(Buffer.from(text.slice(index, end), "utf8"));
      index = end;
      plainStart = end;
    }
    if (plainStart < text.length) this.#appendTail(Buffer.from(text.slice(plainStart), "utf8"));
  }

  #appendAtomic(bytes: Buffer): void {
    if (!this.#headSealed) {
      const available = this.#headBudget - this.#headBytes;
      if (bytes.length <= available) {
        bytes.copy(this.#head, this.#headBytes);
        this.#headBytes += bytes.length;
        return;
      }
      this.#headSealed = true;
      this.#tailBudget = Math.max(0, this.maxBytes - this.#headBytes);
    }
    if (bytes.length > this.#tailBudget || this.#tailBudget === 0) return;
    let index = this.#lastSlotIndex();
    if (index < 0 || this.slabBytes - this.#ends[index]! < bytes.length) index = this.#addSlot();
    bytes.copy(this.#slots[index]!, this.#ends[index]!);
    this.#ends[index] += bytes.length;
    this.#tailBytes += bytes.length;
  }

  #appendTail(bytes: Buffer): void {
    if (bytes.length === 0 || this.#tailBudget === 0) return;
    let offset = 0;
    while (offset < bytes.length) {
      let index = this.#lastSlotIndex();
      if (index < 0) index = this.#addSlot();
      const available = this.slabBytes - this.#ends[index]!;
      const accepted = prefixBytesWithin(bytes, offset, available);
      if (accepted === 0) {
        index = this.#addSlot();
        continue;
      }
      const slab = this.#slots[index]!;
      bytes.copy(slab, this.#ends[index]!, offset, offset + accepted);
      this.#ends[index] += accepted;
      this.#tailBytes += accepted;
      offset += accepted;
      // Recycle as the stream advances; never stage the whole incoming chunk
      // in retained slabs before enforcing the tail budget.
      this.#trimTail();
    }
  }

  #trimTail(): void {
    let excess = this.#tailBytes - this.#tailBudget;
    while (excess > 0 && this.#slotCount > 0) {
      const index = this.#firstSlot;
      const length = this.#ends[index]! - this.#starts[index]!;
      if (length <= excess) {
        excess -= length;
        this.#tailBytes -= length;
        this.#starts[index] = 0;
        this.#ends[index] = 0;
        this.#firstSlot = (this.#firstSlot + 1) % this.#slots.length;
        this.#slotCount -= 1;
        continue;
      }

      const slab = this.#slots[index]!;
      const boundary = nextSafeBufferBoundary(
        slab,
        this.#starts[index]! + excess,
        this.#starts[index]!,
        this.#ends[index]!,
      );
      const removed = boundary - this.#starts[index]!;
      this.#starts[index] = boundary;
      this.#tailBytes -= removed;
      excess = 0;
      if (this.#starts[index] === this.#ends[index]) {
        this.#starts[index] = 0;
        this.#ends[index] = 0;
        this.#firstSlot = (this.#firstSlot + 1) % this.#slots.length;
        this.#slotCount -= 1;
      }
    }
  }

  #tailString(): string {
    if (this.#tailBytes === 0) return "";
    const parts: string[] = [];
    for (let logical = 0; logical < this.#slotCount; logical += 1) {
      const index = this.#slotIndex(logical);
      parts.push(this.#slots[index]!.subarray(this.#starts[index]!, this.#ends[index]!).toString("utf8"));
    }
    return parts.join("");
  }

  #slotIndex(logical: number): number {
    return (this.#firstSlot + logical) % this.#slots.length;
  }

  #lastSlotIndex(): number {
    return this.#slotCount === 0 ? -1 : this.#slotIndex(this.#slotCount - 1);
  }

  #addSlot(): number {
    if (this.#slotCount >= this.#slots.length) {
      throw new Error("safe slab slot capacity exhausted");
    }
    const index = this.#slotIndex(this.#slotCount);
    this.#slots[index] ??= Buffer.allocUnsafe(this.slabBytes);
    this.#starts[index] = 0;
    this.#ends[index] = 0;
    this.#slotCount += 1;
    return index;
  }
}
