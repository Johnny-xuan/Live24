import { ECMA48_MAX_SEQUENCE_CHARS, ESC } from "./ecma48-framer.js";

export interface TextBoundary {
  index: number;
  bytes: number;
}

function utf8SpanAt(text: string, index: number): { codeUnits: number; bytes: number } {
  const first = text.charCodeAt(index);
  if (first <= 0x7f) return { codeUnits: 1, bytes: 1 };
  if (first <= 0x7ff) return { codeUnits: 1, bytes: 2 };
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return { codeUnits: 2, bytes: 4 };
  }
  return { codeUnits: 1, bytes: 3 };
}

function utf8SpanBefore(text: string, end: number, minimum: number): { start: number; bytes: number } {
  let start = end - 1;
  const last = text.charCodeAt(start);
  if (last >= 0xdc00 && last <= 0xdfff && start > minimum) {
    const first = text.charCodeAt(start - 1);
    if (first >= 0xd800 && first <= 0xdbff) start -= 1;
  }
  return { start, bytes: utf8SpanAt(text, start).bytes };
}

/** Returns the exclusive end of one complete SGR token beginning at start. */
export function sgrSequenceEnd(text: string, start: number): number | undefined {
  if (text[start] !== ESC || text[start + 1] !== "[") return undefined;
  const limit = Math.min(text.length, start + ECMA48_MAX_SEQUENCE_CHARS);
  for (let index = start + 2; index < limit; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x6d) return index + 1;
    if ((code >= 0x20 && code <= 0x3f)) continue;
    return undefined;
  }
  return undefined;
}

function sgrSequenceStartBefore(text: string, end: number, minimum: number): number | undefined {
  if (end <= minimum || text.charCodeAt(end - 1) !== 0x6d) return undefined;
  const floor = Math.max(minimum, end - ECMA48_MAX_SEQUENCE_CHARS);
  const start = text.lastIndexOf(ESC, end - 1);
  if (start < floor) return undefined;
  return sgrSequenceEnd(text, start) === end ? start : undefined;
}

/** Largest prefix within a UTF-8 budget, never splitting a code point or SGR. */
export function safePrefixWithin(text: string, budget: number): TextBoundary {
  let index = 0;
  let bytes = 0;
  const limit = Math.max(0, budget);
  while (index < text.length) {
    const sgrEnd = sgrSequenceEnd(text, index);
    const span = sgrEnd === undefined
      ? utf8SpanAt(text, index)
      : { codeUnits: sgrEnd - index, bytes: Buffer.byteLength(text.slice(index, sgrEnd), "utf8") };
    if (bytes + span.bytes > limit) break;
    bytes += span.bytes;
    index += span.codeUnits;
  }
  return { index, bytes };
}

/** Smallest suffix within a UTF-8 budget, never splitting a code point or SGR. */
export function safeSuffixWithin(text: string, budget: number, minimum = 0): TextBoundary {
  let index = text.length;
  let bytes = 0;
  const limit = Math.max(0, budget);
  while (index > minimum) {
    const sgrStart = sgrSequenceStartBefore(text, index, minimum);
    const span = sgrStart === undefined
      ? utf8SpanBefore(text, index, minimum)
      : { start: sgrStart, bytes: Buffer.byteLength(text.slice(sgrStart, index), "utf8") };
    if (bytes + span.bytes > limit) break;
    bytes += span.bytes;
    index = span.start;
  }
  return { index, bytes };
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Advances an eviction point to a UTF-8 and complete-SGR boundary. Input slabs
 * begin at a known safe boundary and SGR tokens never span slabs.
 */
export function nextSafeBufferBoundary(
  bytes: Buffer,
  requested: number,
  start: number,
  end: number,
): number {
  let boundary = Math.min(Math.max(start, requested), end);
  while (boundary < end && isUtf8Continuation(bytes[boundary]!)) boundary += 1;

  const floor = Math.max(start, boundary - ECMA48_MAX_SEQUENCE_CHARS);
  for (let candidate = boundary - 1; candidate >= floor; candidate -= 1) {
    if (bytes[candidate] !== 0x1b || bytes[candidate + 1] !== 0x5b) continue;
    const limit = Math.min(end, candidate + ECMA48_MAX_SEQUENCE_CHARS);
    for (let cursor = candidate + 2; cursor < limit; cursor += 1) {
      const code = bytes[cursor]!;
      if (code === 0x6d) {
        const tokenEnd = cursor + 1;
        if (candidate < boundary && tokenEnd > boundary) return tokenEnd;
        break;
      }
      if (code < 0x20 || code > 0x3f) break;
    }
  }
  return boundary;
}
