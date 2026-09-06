/**
 * Compatibility façade for the framed terminal-output pipeline.
 *
 * Ecma48Framer owns incremental protocol recognition and hard parser bounds.
 * TranscriptReducer owns newline/current-row/SGR projection and retention.
 * ManagedProcess may supply per-source framed events through consume(), while
 * direct callers retain the original write()/end() API through a private framer.
 */

import { OUTPUT_MAX_BYTES } from "../constants.js";
import { ESC, Ecma48Framer, type TranscriptEvent } from "./ecma48-framer.js";
import type { OutputSnapshot } from "./head-tail-buffer.js";
import {
  TranscriptReducer,
  type TranscriptReducerOptions,
} from "./transcript-reducer.js";

export type AnsiSanitizerOptions = TranscriptReducerOptions;

export class AnsiSanitizer {
  readonly #framer = new Ecma48Framer();
  readonly #reducer: TranscriptReducer;

  constructor(
    maxLineBytes = OUTPUT_MAX_BYTES,
    terminalSize: { cols: number; rows: number } = { cols: 120, rows: 30 },
    options: AnsiSanitizerOptions = {},
  ) {
    this.#reducer = new TranscriptReducer(maxLineBytes, terminalSize, options);
  }

  get currentLine(): string {
    return this.#reducer.currentLine;
  }

  get currentLineActive(): boolean {
    return this.#reducer.currentLineActive;
  }

  get fullscreenActive(): boolean {
    return this.#reducer.fullscreenActive;
  }

  get screenMode(): boolean {
    return this.#reducer.screenMode;
  }

  get synchronizedFrameActive(): boolean {
    return this.#reducer.synchronizedFrameActive;
  }

  get suppressedChars(): number {
    return this.#reducer.suppressedChars;
  }

  snapshotCurrentLine(): OutputSnapshot {
    return this.#reducer.snapshotCurrentLine();
  }

  snapshotCurrentLineDelta(): OutputSnapshot {
    return this.#reducer.snapshotCurrentLineDelta();
  }

  markCurrentLineDelivered(): void {
    this.#reducer.markCurrentLineDelivered();
  }

  drainCommittedOutput(): OutputSnapshot {
    return this.#reducer.drainCommittedOutput();
  }

  resizeTerminal(cols: number, rows: number): void {
    this.#reducer.resizeTerminal(cols, rows);
  }

  write(chunk: string): string {
    return this.consume(this.#framer.write(chunk).events);
  }

  /** Accepts records from a source-specific framer without sharing parser state. */
  consume(events: readonly TranscriptEvent[]): string {
    return this.#reducer.write(events);
  }

  end(): string {
    const framed = this.#framer.end();
    return this.#reducer.write(framed.events) + this.#reducer.end();
  }
}

/** One-shot convenience wrapper around {@link AnsiSanitizer}. */
export function sanitizeAnsiSync(text: string): string {
  if (!text.includes(ESC) && !needsControlNormalization(text)) return text;
  const sanitizer = new AnsiSanitizer();
  return sanitizer.write(text) + sanitizer.end() + sanitizer.currentLine;
}

function needsControlNormalization(text: string): boolean {
  return /\r/.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1a\x7f]/.test(text) || /[\x80-\x9f]/.test(text);
}
