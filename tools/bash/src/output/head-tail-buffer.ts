// Source-informed adaptation of OpenAI Codex rust-v0.147.0
// codex-rs/core/src/unified_exec/head_tail_buffer.rs, modified to preserve code points.
import { OUTPUT_MAX_BYTES } from "../constants.js";
import { safePrefixWithin, safeSuffixWithin } from "./ansi-boundary.js";
import { materializeOutputSnapshot } from "./presenter.js";
import { utf8Bytes } from "./truncate.js";
import { SafeSlabStore } from "./safe-slab-store.js";

export interface OutputSnapshot {
  head: string;
  tail: string;
  omittedBytes: number;
  totalBytes: number;
  materialized: string;
}

const REPLACEMENT_CHARACTER = "\ufffd";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Converts malformed UTF-16 to the same replacement characters TextEncoder emits. */
function normalizeLoneSurrogates(text: string): string {
  if (!/[\ud800-\udfff]/.test(text)) return text;
  let normalized = "";
  let unchangedStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1))) {
      index += 1;
      continue;
    }
    if (!isHighSurrogate(code) && !isLowSurrogate(code)) continue;
    normalized += text.slice(unchangedStart, index) + REPLACEMENT_CHARACTER;
    unchangedStart = index + 1;
  }
  return normalized ? normalized + text.slice(unchangedStart) : text;
}

export class HeadTailBuffer {
  readonly maxBytes: number;
  #pendingHighSurrogate = "";
  #storage: SafeSlabStore;

  constructor(maxBytes = OUTPUT_MAX_BYTES) {
    this.maxBytes = Math.max(0, maxBytes);
    this.#storage = new SafeSlabStore(this.maxBytes);
  }

  push(text: string): void {
    if (!text) return;
    let resolved = this.#pendingHighSurrogate + text;
    this.#pendingHighSurrogate = "";
    if (isHighSurrogate(resolved.charCodeAt(resolved.length - 1))) {
      this.#pendingHighSurrogate = resolved.slice(-1);
      resolved = resolved.slice(0, -1);
    }
    if (resolved) this.#pushResolved(normalizeLoneSurrogates(resolved));
  }

  /** Appends one complete framed control token atomically. */
  pushSafeToken(text: string): void {
    this.#finalizePendingSurrogate();
    this.#storage.pushSafeToken(text);
  }

  /** Appends another bounded snapshot without treating its omission marker as data. */
  pushSnapshot(snapshot: OutputSnapshot): void {
    if (snapshot.totalBytes === 0) return;
    if (snapshot.omittedBytes === 0) {
      // The complete source is available, so use the amortized append path.
      this.push(snapshot.materialized);
      return;
    }
    this.#finalizePendingSurrogate();
    this.#loadSnapshot(combineOutputSnapshots(this.#snapshotResolved(), snapshot, this.maxBytes));
  }

  snapshot(): OutputSnapshot {
    if (this.#pendingHighSurrogate) {
      const view = this.#clone();
      view.#finalizePendingSurrogate();
      return view.#snapshotResolved();
    }
    return this.#snapshotResolved();
  }

  /** Returns a bounded view with a replaceable suffix without storing it. */
  snapshotWithSuffix(suffix: string): OutputSnapshot {
    if (!suffix) return this.snapshot();
    const view = this.#clone();
    view.push(suffix);
    return view.snapshot();
  }

  /** Returns a bounded view with one atomic framed-control suffix. */
  snapshotWithSafeToken(token: string): OutputSnapshot {
    if (!token) return this.snapshot();
    const view = this.#clone();
    view.pushSafeToken(token);
    return view.snapshot();
  }

  drain(): OutputSnapshot {
    const snapshot = this.snapshot();
    this.clear();
    return snapshot;
  }

  /** Drains committed content while composing, but not retaining, a live suffix. */
  drainWithSuffix(suffix: string): OutputSnapshot {
    const snapshot = this.snapshotWithSuffix(suffix);
    this.clear();
    return snapshot;
  }

  clear(): void {
    this.#storage.clear();
    this.#pendingHighSurrogate = "";
  }

  #clone(): HeadTailBuffer {
    const clone = new HeadTailBuffer(this.maxBytes);
    clone.#storage = this.#storage.clone();
    clone.#pendingHighSurrogate = this.#pendingHighSurrogate;
    return clone;
  }

  #pushResolved(text: string): void {
    this.#storage.push(text);
  }

  #finalizePendingSurrogate(): void {
    if (!this.#pendingHighSurrogate) return;
    this.#pendingHighSurrogate = "";
    this.#pushResolved(REPLACEMENT_CHARACTER);
  }

  #snapshotResolved(): OutputSnapshot {
    return this.#storage.snapshot();
  }

  #loadSnapshot(snapshot: OutputSnapshot): void {
    this.#pendingHighSurrogate = "";
    this.#storage.loadSnapshot(snapshot);
  }
}

/**
 * Concatenates two bounded snapshots while preserving their original byte and
 * omission counts. Omission markers are presentation, never input data.
 */
export function combineOutputSnapshots(
  first: OutputSnapshot,
  second: OutputSnapshot,
  maxBytes = OUTPUT_MAX_BYTES,
): OutputSnapshot {
  maxBytes = Math.max(0, maxBytes);
  const totalBytes = first.totalBytes + second.totalBytes;
  if (first.omittedBytes === 0 && second.omittedBytes === 0) {
    const direct = new HeadTailBuffer(maxBytes);
    direct.push(first.materialized);
    direct.push(second.materialized);
    return direct.snapshot();
  }

  let head: string;
  let tailSource: string;
  if (first.omittedBytes > 0) {
    // Once overflow seals the first snapshot's head, later data may only roll
    // its tail. Never feed the old tail back through a fresh head split. The
    // known prefix must still be rebound when the target budget is smaller.
    const headCut = safePrefixWithin(first.head, Math.floor(maxBytes / 2));
    head = first.head.slice(0, headCut.index);
    // If the second snapshot already omitted a middle, its tail is no longer
    // adjacent to the first tail; only the second stable tail can survive.
    tailSource = second.omittedBytes > 0 ? second.tail : `${first.tail}${second.materialized}`;
  } else {
    // The second snapshot already lost its middle. Reconstruct the combined
    // stable head from all still-known prefix bytes and keep its stable tail.
    const headSource = `${first.materialized}${second.head}`;
    const headCut = safePrefixWithin(headSource, Math.floor(maxBytes / 2));
    head = headSource.slice(0, headCut.index);
    tailSource = second.tail;
  }

  const headBytes = utf8Bytes(head);
  const tailCut = safeSuffixWithin(tailSource, Math.max(0, maxBytes - headBytes), 0);
  const tail = tailSource.slice(tailCut.index);
  const omittedBytes = totalBytes - headBytes - tailCut.bytes;
  const snapshot: OutputSnapshot = {
    head,
    tail,
    omittedBytes,
    totalBytes,
    materialized: "",
  };
  snapshot.materialized = materializeOutputSnapshot(snapshot);
  return snapshot;
}
