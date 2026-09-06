import { OUTPUT_MAX_BYTES } from "../constants.js";
import { sgrSequenceEnd } from "./ansi-boundary.js";
import type { TranscriptEvent } from "./ecma48-framer.js";
import { ESC } from "./ecma48-framer.js";
import { HeadTailBuffer, type OutputSnapshot } from "./head-tail-buffer.js";

const RESET_SGR = `${ESC}[0m`;
const MAX_ACTIVE_SGR_CHARS = 1024;

function privateModeParameters(body: string): Set<number> {
  if (!body.startsWith("?")) return new Set();
  const modes = new Set<number>();
  for (const parameter of body.slice(1).split(";")) {
    if (!/^\d+$/.test(parameter)) continue;
    modes.add(Number(parameter));
  }
  return modes;
}

function pushSgrReplay(buffer: HeadTailBuffer, replay: string): void {
  let index = 0;
  while (index < replay.length) {
    const end = sgrSequenceEnd(replay, index);
    if (end === undefined) {
      buffer.push(replay.slice(index));
      return;
    }
    buffer.pushSafeToken(replay.slice(index, end));
    index = end;
  }
}

export interface TranscriptReducerOptions {
  /** A separate terminal-state backend owns alternate-screen snapshots. */
  externalFullScreen?: boolean;
  /** A separate terminal-state backend owns cursor-addressed screen snapshots. */
  externalScreen?: boolean;
}

/**
 * Reduces framed terminal events into stable transcript history plus one
 * replaceable current row. It never parses raw escape bytes.
 */
export class TranscriptReducer {
  #line: HeadTailBuffer;
  #lineHasVisibleText = false;
  #lineNeedsReset = false;
  #lineGeneration = 0;
  #deliveredLineGeneration = -1;
  #deliveredRawLine = "";
  #deliveredActiveSgr = "";
  #committed = new HeadTailBuffer();
  #activeSgr = "";
  #pendingCr = false;
  #fullscreenActive = false;
  #periodSuppressedChars = 0;
  #screenMode = false;
  #syncFrameActive = false;
  readonly #externalFullScreen: boolean;

  constructor(
    maxLineBytes = OUTPUT_MAX_BYTES,
    terminalSize: { cols: number; rows: number } = { cols: 120, rows: 30 },
    options: TranscriptReducerOptions = {},
  ) {
    this.#line = new HeadTailBuffer(maxLineBytes);
    void terminalSize;
    void options.externalScreen;
    this.#externalFullScreen = options.externalFullScreen ?? false;
  }

  get currentLine(): string {
    return this.snapshotCurrentLine().materialized;
  }

  get currentLineActive(): boolean {
    return !this.#screenMode && !this.#fullscreenActive && this.#lineHasVisibleText;
  }

  get fullscreenActive(): boolean {
    return this.#fullscreenActive;
  }

  get screenMode(): boolean {
    return this.#screenMode;
  }

  get synchronizedFrameActive(): boolean {
    return this.#syncFrameActive;
  }

  get suppressedChars(): number {
    return this.#periodSuppressedChars;
  }

  snapshotCurrentLine(): OutputSnapshot {
    if (this.#screenMode) return this.#emptySnapshot();
    if (!this.#lineHasVisibleText) return this.#emptySnapshot();
    return this.#lineNeedsReset ? this.#line.snapshotWithSafeToken(RESET_SGR) : this.#line.snapshot();
  }

  snapshotCurrentLineDelta(): OutputSnapshot {
    if (this.#screenMode) return this.#emptySnapshot();
    if (!this.#lineHasVisibleText) return this.#emptySnapshot();
    const raw = this.#line.snapshot();
    if (
      this.#deliveredLineGeneration !== this.#lineGeneration
      || raw.omittedBytes > 0
      || !raw.materialized.startsWith(this.#deliveredRawLine)
    ) {
      return this.snapshotCurrentLine();
    }
    const suffix = raw.materialized.slice(this.#deliveredRawLine.length);
    if (!suffix) return this.#emptySnapshot();
    const delta = new HeadTailBuffer(this.#line.maxBytes);
    if (this.#deliveredActiveSgr) pushSgrReplay(delta, this.#deliveredActiveSgr);
    delta.push(suffix);
    if (this.#deliveredActiveSgr || this.#lineNeedsReset) delta.pushSafeToken(RESET_SGR);
    return delta.snapshot();
  }

  markCurrentLineDelivered(): void {
    if (this.#screenMode) return;
    const raw = this.#line.snapshot();
    if (!this.#lineHasVisibleText || raw.omittedBytes > 0) {
      this.#clearDeliveredLine();
      return;
    }
    this.#deliveredLineGeneration = this.#lineGeneration;
    this.#deliveredRawLine = raw.materialized;
    this.#deliveredActiveSgr = this.#activeSgr;
  }

  drainCommittedOutput(): OutputSnapshot {
    return this.#committed.drain();
  }

  resizeTerminal(cols: number, rows: number): void {
    void cols;
    void rows;
  }

  write(events: readonly TranscriptEvent[]): string {
    if (events.length === 0) return "";
    const committed: string[] = [];
    for (const event of events) {
      let output = "";
      if (event.type === "text") output = this.#text(event.text, event.sourceChars);
      else if (event.type === "control") output = this.#control(event.value, event.sourceChars);
      else if (event.type === "csi") output = this.#csi(event);
      else if (event.type === "escape") output = this.#escape(event.final, event.sourceChars);
      else if (this.#fullscreenActive) this.#periodSuppressedChars += event.sourceChars;
      if (output) committed.push(output);
    }
    return committed.join("");
  }

  end(): string {
    let committed = "";
    this.#pendingCr = false;
    this.#syncFrameActive = false;
    if (this.#fullscreenActive) {
      this.#fullscreenActive = false;
      if (!this.#externalFullScreen) {
        const placeholder = this.#placeholder();
        this.#committed.push(placeholder);
        committed += placeholder;
      }
      this.#periodSuppressedChars = 0;
    }
    return committed;
  }

  #text(text: string, sourceChars: number): string {
    if (this.#fullscreenActive) {
      this.#periodSuppressedChars += sourceChars;
      return "";
    }
    if (this.#screenMode) return "";
    this.#appendGroundText(text);
    return "";
  }

  #control(value: string, sourceChars: number): string {
    if (this.#fullscreenActive) {
      this.#periodSuppressedChars += sourceChars;
      return "";
    }
    if (this.#screenMode) return "";
    if (value === "\r") {
      this.#pendingCr = true;
      return "";
    }
    if (value === "\n") {
      this.#pendingCr = false;
      return this.#commitLine();
    }
    return "";
  }

  #escape(final: string, sourceChars: number): string {
    if (this.#fullscreenActive) {
      this.#periodSuppressedChars += sourceChars;
      return "";
    }
    void final;
    return "";
  }

  #csi(event: Extract<TranscriptEvent, { type: "csi" }>): string {
    const { body, final, hasPrivateMarker, hasIntermediate, sourceChars } = event;
    const modeChange = final === "h" || final === "l";
    const privateModes = hasPrivateMarker && modeChange ? privateModeParameters(body) : new Set<number>();
    const hasAlternateMode = privateModes.has(1049) || privateModes.has(1047) || privateModes.has(47);
    const hasSynchronizedMode = privateModes.has(2026);
    let boundaryOutput = "";

    // DEC mode events may carry several parameters. Update every boundary
    // that Xterm will execute so transcript classification and the sole screen
    // authority cannot diverge on sequences such as CSI ?1049;2026l.
    if (hasSynchronizedMode) {
      if (final === "h") {
        boundaryOutput += this.#enterScreenMode();
        this.#syncFrameActive = true;
        this.#pendingCr = false;
      } else {
        this.#syncFrameActive = false;
      }
    }

    if (hasAlternateMode) {
      if (final === "h" && !this.#fullscreenActive) {
        boundaryOutput += this.#flushLineBeforeBoundary();
        this.#pendingCr = false;
        this.#fullscreenActive = true;
        this.#periodSuppressedChars = 0;
      } else if (final === "l" && this.#fullscreenActive) {
        this.#fullscreenActive = false;
        const placeholder = this.#externalFullScreen ? "" : this.#placeholder();
        if (placeholder) this.#committed.push(placeholder);
        boundaryOutput += placeholder;
        this.#periodSuppressedChars = 0;
      }
    }

    if (hasAlternateMode || hasSynchronizedMode) return boundaryOutput;

    if (this.#fullscreenActive) {
      this.#periodSuppressedChars += sourceChars;
      return "";
    }

    if (
      !this.#screenMode
      && !this.#lineHasVisibleText
      && final === "J"
      && !hasPrivateMarker
      && !hasIntermediate
    ) {
      return this.#enterScreenMode();
    }

    if (this.#screenMode) return "";

    if (final === "K") {
      if (this.#pendingCr || body === "2") {
        this.#pendingCr = false;
        this.#replaceLine();
      }
      return "";
    }

    if (final !== "m" || hasPrivateMarker || hasIntermediate) return "";
    const sequence = `${ESC}[${body}${final}`;
    this.#updateActiveSgr(body, sequence);
    if (!this.#pendingCr) {
      this.#line.pushSafeToken(sequence);
      this.#lineNeedsReset = this.#activeSgr.length > 0;
    }
    return "";
  }

  #appendGroundText(text: string): void {
    if (this.#pendingCr) {
      this.#pendingCr = false;
      this.#replaceLine();
    }
    this.#line.push(text);
    this.#lineHasVisibleText = true;
  }

  #placeholder(): string {
    return `[full-screen frame output suppressed: ${this.#periodSuppressedChars} characters]\n`;
  }

  #emptySnapshot(): OutputSnapshot {
    return new HeadTailBuffer(this.#line.maxBytes).snapshot();
  }

  #enterScreenMode(): string {
    if (this.#screenMode) return "";
    const prefix = this.#flushLineBeforeBoundary();
    this.#screenMode = true;
    this.#pendingCr = false;
    return prefix;
  }

  #clearDeliveredLine(): void {
    this.#deliveredLineGeneration = -1;
    this.#deliveredRawLine = "";
    this.#deliveredActiveSgr = "";
  }

  #resetLineToActiveStyle(): void {
    this.#line.clear();
    if (this.#activeSgr) pushSgrReplay(this.#line, this.#activeSgr);
    this.#lineHasVisibleText = false;
    this.#lineNeedsReset = this.#activeSgr.length > 0;
    this.#lineGeneration += 1;
    this.#clearDeliveredLine();
  }

  #commitLine(): string {
    const full = this.snapshotCurrentLine();
    this.#committed.pushSnapshot(this.snapshotCurrentLineDelta());
    this.#committed.push("\n");
    const line = `${full.materialized}\n`;
    this.#resetLineToActiveStyle();
    return line;
  }

  #replaceLine(): void {
    this.#resetLineToActiveStyle();
  }

  #flushLineBeforeBoundary(): string {
    if (!this.#lineHasVisibleText) return "";
    return this.#commitLine();
  }

  #updateActiveSgr(body: string, sequence: string): void {
    if (body === "" || body === "0") {
      this.#activeSgr = "";
      return;
    }
    const firstParam = body.split(/[;:]/, 1)[0];
    if (firstParam === "0") {
      this.#activeSgr = sequence;
      return;
    }
    if (this.#activeSgr.endsWith(sequence)) return;
    const next = this.#activeSgr + sequence;
    this.#activeSgr = next.length <= MAX_ACTIVE_SGR_CHARS ? next : `${RESET_SGR}${sequence}`;
  }
}
