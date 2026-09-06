import { safePrefixWithin, safeSuffixWithin } from "./ansi-boundary.js";
import { ESC } from "./ecma48-framer.js";
import type { OutputSnapshot } from "./head-tail-buffer.js";
import { lineCountLikeRust, utf8Bytes } from "./truncate.js";

const RESET_SGR = `${ESC}[0m`;

export interface TokenBudgetResult {
  text: string;
  truncated: boolean;
  removedBytes: number;
}

export interface PresentedOutput extends TokenBudgetResult {
  originalTokenCount: number;
  omittedBytes: number;
}

function containsSgr(text: string): boolean {
  return text.includes(`${ESC}[`);
}

function resetAfterStyled(text: string): string {
  return containsSgr(text) && !text.endsWith(RESET_SGR) ? `${text}${RESET_SGR}` : text;
}

/** Materializes retention metadata without counting presentation markers as data. */
export function materializeOutputSnapshot(snapshot: OutputSnapshot): string {
  if (snapshot.omittedBytes === 0) return snapshot.head + snapshot.tail;
  const head = resetAfterStyled(snapshot.head);
  const tail = containsSgr(snapshot.tail)
    ? `${snapshot.tail.startsWith(RESET_SGR) ? "" : RESET_SGR}${resetAfterStyled(snapshot.tail)}`
    : snapshot.tail;
  return `${head}\n... ${snapshot.omittedBytes} bytes omitted ...\n${tail}`;
}

/** Middle truncation that treats every complete SGR sequence as one atomic token. */
export function truncateMiddleAnsiUtf8(text: string, byteBudget: number): { text: string; removedBytes: number } {
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= byteBudget) return { text, removedBytes: 0 };

  const leftBudget = Math.floor(Math.max(0, byteBudget) / 2);
  const rightBudget = Math.max(0, byteBudget) - leftBudget;
  const left = safePrefixWithin(text, leftBudget);
  const right = safeSuffixWithin(text, rightBudget, left.index);
  const removedBytes = totalBytes - left.bytes - right.bytes;
  const removedTokens = Math.ceil(removedBytes / 4);
  const prefix = text.slice(0, left.index);
  const suffix = text.slice(right.index);
  const marker = `…${removedTokens} tokens truncated…`;

  if (!containsSgr(text)) return { text: `${prefix}${marker}${suffix}`, removedBytes };
  const closedPrefix = prefix.endsWith(RESET_SGR) ? prefix : `${prefix}${RESET_SGR}`;
  const resetSuffix = suffix.startsWith(RESET_SGR) ? suffix : `${RESET_SGR}${suffix}`;
  return {
    text: `${closedPrefix}${marker}${resetAfterStyled(resetSuffix)}`,
    removedBytes,
  };
}

export function applyTokenBudget(
  materialized: string,
  maxTokens: number,
  originalTokenCount: number,
): TokenBudgetResult {
  const byteBudget = Math.max(0, maxTokens) * 4;
  if (utf8Bytes(materialized) <= byteBudget) {
    return { text: materialized, truncated: false, removedBytes: 0 };
  }

  const truncated = truncateMiddleAnsiUtf8(materialized, byteBudget);
  return {
    text: `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${lineCountLikeRust(materialized)}\n\n${truncated.text}`,
    truncated: true,
    removedBytes: truncated.removedBytes,
  };
}

export function presentOutput(snapshot: OutputSnapshot, maxTokens: number): PresentedOutput {
  const originalTokenCount = Math.ceil(snapshot.totalBytes / 4);
  const budgeted = applyTokenBudget(materializeOutputSnapshot(snapshot), maxTokens, originalTokenCount);
  return {
    ...budgeted,
    originalTokenCount,
    omittedBytes: snapshot.omittedBytes,
  };
}

/** Compact TUI projection with Unicode/SGR-safe suffix boundaries. */
export function compactOutputForTool(output: string, expanded: boolean, maxBytes = 4_000): string {
  if (expanded) return output;
  const lines = output.split("\n");
  const selected = lines.length > 6 ? [`… ${lines.length - 6} earlier lines`, ...lines.slice(-6)] : lines;
  const text = selected.join("\n");
  if (utf8Bytes(text) <= maxBytes) return text;
  const suffix = safeSuffixWithin(text, maxBytes).index;
  const compacted = `… ${utf8Bytes(text.slice(0, suffix))} earlier bytes\n${text.slice(suffix)}`;
  return containsSgr(text) ? `${RESET_SGR}${compacted}${RESET_SGR}` : compacted;
}
