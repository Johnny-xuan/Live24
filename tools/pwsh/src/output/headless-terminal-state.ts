import xtermDefault, * as xtermNamespace from "@xterm/headless";
import type { IBufferCell, IBufferLine, Terminal as XtermTerminal } from "@xterm/headless";
import {
  OUTPUT_MAX_BYTES,
  TERMINAL_CELL_ATTACHMENT_BYTES_PER_CELL,
  TERMINAL_WRITE_HIGH_WATER_BYTES,
  TERMINAL_WRITE_LOW_WATER_BYTES,
} from "../constants.js";
import { HeadTailBuffer, type OutputSnapshot } from "./head-tail-buffer.js";
import { isXtermUnicodeV6CellAttachment } from "./xterm-unicode-v6.js";

const ESC = "\x1b";
type TerminalConstructor = typeof import("@xterm/headless").Terminal;
function resolveTerminalConstructor(): TerminalConstructor {
  const namespaceExport = xtermNamespace as unknown as { Terminal?: TerminalConstructor };
  const defaultExport = xtermDefault as unknown as { Terminal?: TerminalConstructor } | undefined;
  const constructor = namespaceExport.Terminal ?? defaultExport?.Terminal;
  if (!constructor) throw new Error("@xterm/headless did not expose Terminal");
  return constructor;
}
const Terminal = resolveTerminalConstructor();

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

type ColorMode = "default" | "palette" | "rgb";

interface CellStyle {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  hidden: boolean;
  strike: boolean;
  foregroundMode: ColorMode;
  foreground: number;
  backgroundMode: ColorMode;
  background: number;
}

export interface HeadlessTerminalOptions {
  onResponse?: (data: string) => void;
  onChange?: () => void;
}

export interface ViewportOptions {
  ansi?: boolean;
  cursor?: boolean;
  pad?: boolean;
}

export interface HeadlessTerminalWriteOptions {
  /** Publish a new viewport generation after this admitted write completes. */
  publishSnapshot?: boolean;
  /** Normal transcript after alternate exit supersedes the saved viewport. */
  discardLastAlternateSnapshot?: boolean;
}

function defaultStyle(): CellStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    blink: false,
    inverse: false,
    hidden: false,
    strike: false,
    foregroundMode: "default",
    foreground: 0,
    backgroundMode: "default",
    background: 0,
  };
}

function colorMode(cell: IBufferCell, foreground: boolean): ColorMode {
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return "rgb";
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
    const value = foreground ? cell.getFgColor() : cell.getBgColor();
    return value >= 0 && value <= 255 ? "palette" : "default";
  }
  return "default";
}

function styleFromCell(cell: IBufferCell): CellStyle {
  return {
    bold: !!cell.isBold(),
    dim: !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    blink: !!cell.isBlink(),
    inverse: !!cell.isInverse(),
    hidden: !!cell.isInvisible(),
    strike: !!cell.isStrikethrough(),
    foregroundMode: colorMode(cell, true),
    foreground: cell.getFgColor(),
    backgroundMode: colorMode(cell, false),
    background: cell.getBgColor(),
  };
}

function colorSgr(foreground: boolean, mode: ColorMode, value: number): string {
  if (mode === "default") return foreground ? "39" : "49";
  if (mode === "palette") {
    if (value >= 0 && value <= 7) return String((foreground ? 30 : 40) + value);
    if (value >= 8 && value <= 15) return String((foreground ? 90 : 100) + value - 8);
    return `${foreground ? 38 : 48};5;${value}`;
  }
  const base = foreground ? "38" : "48";
  return `${base};2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}`;
}

function sameColor(current: CellStyle, next: CellStyle, foreground: boolean): boolean {
  const modeKey = foreground ? "foregroundMode" : "backgroundMode";
  const valueKey = foreground ? "foreground" : "background";
  return current[modeKey] === next[modeKey]
    && (current[modeKey] === "default" || current[valueKey] === next[valueKey]);
}

function transitionStyle(current: CellStyle, next: CellStyle): string {
  const params: string[] = [];
  const turnsOffBoldOrDim = (current.bold && !next.bold) || (current.dim && !next.dim);
  if (turnsOffBoldOrDim) {
    params.push("22");
    if (next.bold) params.push("1");
    if (next.dim) params.push("2");
  } else {
    if (!current.bold && next.bold) params.push("1");
    if (!current.dim && next.dim) params.push("2");
  }
  const attributes: Array<[keyof CellStyle, string, string]> = [
    ["italic", "3", "23"],
    ["underline", "4", "24"],
    ["blink", "5", "25"],
    ["inverse", "7", "27"],
    ["hidden", "8", "28"],
    ["strike", "9", "29"],
  ];
  for (const [key, enable, disable] of attributes) {
    if (!current[key] && next[key]) params.push(enable);
    else if (current[key] && !next[key]) params.push(disable);
  }
  if (!sameColor(current, next, true)) {
    params.push(colorSgr(true, next.foregroundMode, next.foreground));
  }
  if (!sameColor(current, next, false)) {
    params.push(colorSgr(false, next.backgroundMode, next.background));
  }
  return params.length > 0 ? `${ESC}[${params.join(";")}m` : "";
}

function cellHasBackground(style: CellStyle): boolean {
  return style.backgroundMode !== "default" || style.inverse;
}

function isAlternateModeParameter(value: number): boolean {
  return value === 47 || value === 1047 || value === 1049;
}

/**
 * A bounded xterm.js-backed terminal state shared by model snapshots and human
 * attachment. It does not own the PTY or any process lifecycle.
 */
export class HeadlessTerminalState {
  readonly highWaterBytes = TERMINAL_WRITE_HIGH_WATER_BYTES;
  readonly lowWaterBytes = TERMINAL_WRITE_LOW_WATER_BYTES;
  readonly #terminal: XtermTerminal;
  readonly #onResponse?: (data: string) => void;
  readonly #onChange?: () => void;
  #response = "";
  #responseImmediate?: NodeJS.Immediate;
  #alternateActive = false;
  #snapshotMode = false;
  #snapshotActive = false;
  #snapshotDirty = false;
  #lastSuppressedGeneration = 0;
  #lastPublishableGeneration = 0;
  #lastAdmissionPublishable = true;
  #publicationBarrierGeneration?: number;
  #generation = 0;
  #deliveredGeneration = -1;
  #viewportSnapshot = "";
  #lastAlternateSnapshot = "";
  #lastAlternatePending = false;
  #deferredAlternate?: { snapshot: string; generation: number };
  #discardAlternateThroughGeneration = 0;
  #maxCellsSeen: number;
  #cellAttachmentBytes = 0;
  #droppedCellAttachmentBytes = 0;
  #snapshotMaterializations = 0;
  #pendingBytes = 0;
  #admittedGeneration = 0;
  #completedGeneration = 0;
  #completedOutOfOrder = new Set<number>();
  #writePublishability = new Map<number, boolean>();
  #flushWaiters: Array<{ targetGeneration: number; resolve(): void }> = [];
  #pressureListeners = new Set<() => void>();
  #failed = false;
  #disposed = false;

  constructor(cols: number, rows: number, options: HeadlessTerminalOptions = {}) {
    this.#onResponse = options.onResponse;
    this.#onChange = options.onChange;
    this.#maxCellsSeen = Math.max(1, cols * rows);
    this.#terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      // Stable history belongs to the byte-bounded transcript store. Xterm is
      // the mutable PTY viewport authority only, so line-count scrollback would
      // duplicate history with a much larger geometry-dependent memory cost.
      scrollback: 0,
      logLevel: "off",
    });

    this.#terminal.onData((data) => {
      if (!this.#onResponse || this.#disposed) return;
      this.#response += data;
      if (this.#responseImmediate) return;
      this.#responseImmediate = setImmediate(() => {
        this.#responseImmediate = undefined;
        const response = this.#response;
        this.#response = "";
        if (response && !this.#disposed) this.#onResponse?.(response);
      });
    });

    // Capture the final alternate viewport before xterm switches back to and
    // clears the normal buffer. Returning false lets xterm's built-in handler
    // continue processing the mode change.
    this.#terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (
        params.some((value) => typeof value === "number" && isAlternateModeParameter(value))
        && this.#terminal.buffer.active.type === "alternate"
      ) {
        const snapshot = this.#renderSnapshot();
        const parsingGeneration = this.#completedGeneration + 1;
        if (parsingGeneration <= this.#discardAlternateThroughGeneration) return false;
        if (this.#writePublishability.get(parsingGeneration) === false) {
          this.#deferredAlternate = { snapshot, generation: parsingGeneration };
        } else {
          this.#publishAlternateSnapshot(snapshot);
        }
      }
      return false;
    });
  }

  get cols(): number {
    return this.#terminal.cols;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  get alternateActive(): boolean {
    return this.#alternateActive;
  }

  get lastAlternateSnapshot(): string {
    return this.#lastAlternateSnapshot;
  }

  get hasPendingSnapshot(): boolean {
    return this.#alternateActive || this.#snapshotMode || this.#snapshotActive || this.#lastAlternatePending;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  cellPayloadStats(): {
    attachmentBudgetBytes: number;
    attachmentBytes: number;
    droppedAttachmentBytes: number;
    snapshotMaterializations: number;
  } {
    return {
      attachmentBudgetBytes: this.#maxCellsSeen * TERMINAL_CELL_ATTACHMENT_BYTES_PER_CELL,
      attachmentBytes: this.#cellAttachmentBytes,
      droppedAttachmentBytes: this.#droppedCellAttachmentBytes,
      snapshotMaterializations: this.#snapshotMaterializations,
    };
  }

  get available(): boolean {
    return !this.#failed && !this.#disposed;
  }

  subscribePressure(listener: () => void): () => void {
    this.#pressureListeners.add(listener);
    return () => this.#pressureListeners.delete(listener);
  }

  setSnapshotMode(active: boolean): void {
    if (this.#disposed || active === this.#snapshotMode) return;
    this.#snapshotMode = active;
    // Entering screen classification alone must not expose bytes from a DEC
    // synchronized frame. A completed write or commitSnapshot publishes it.
    if (!active) this.#queueSnapshotRefresh(true);
  }

  write(data: string, options: HeadlessTerminalWriteOptions = {}): void {
    if (!data || this.#disposed || this.#failed) return;
    const boundedData = this.#boundCellAttachments(data);
    if (!boundedData) return;
    const publishSnapshot = options.publishSnapshot ?? true;
    // Preserve an already-completed publishable frame before admitting bytes
    // that belong to an open DEC synchronized frame.
    if (
      !publishSnapshot
      && this.#snapshotDirty
      && this.#completedGeneration >= this.#admittedGeneration
    ) this.#materializeSnapshot();
    const bytes = Buffer.byteLength(boundedData, "utf8");
    const generation = ++this.#admittedGeneration;
    this.#writePublishability.set(generation, publishSnapshot);
    const beginsSuppressedRun = !publishSnapshot && this.#lastAdmissionPublishable;
    this.#lastAdmissionPublishable = publishSnapshot;
    if (!publishSnapshot) {
      this.#lastSuppressedGeneration = generation;
      if (beginsSuppressedRun) this.#publicationBarrierGeneration = generation - 1;
    }
    this.#pendingBytes += bytes;
    if (options.discardLastAlternateSnapshot) this.#discardAlternateSnapshotThrough(generation);
    try {
      this.#terminal.write(boundedData, () => {
        this.#completeWrite(
          generation,
          bytes,
          publishSnapshot,
          options.discardLastAlternateSnapshot ?? false,
        );
      });
    } catch {
      this.#disable();
    }
  }

  discardLastAlternateSnapshot(): void {
    this.#discardAlternateSnapshotThrough(this.#admittedGeneration);
  }

  #discardAlternateSnapshotThrough(generation: number): void {
    this.#discardAlternateThroughGeneration = Math.max(this.#discardAlternateThroughGeneration, generation);
    this.#lastAlternatePending = false;
    if (this.#deferredAlternate && this.#deferredAlternate.generation <= generation) {
      this.#deferredAlternate = undefined;
    }
  }

  async flush(): Promise<void> {
    const targetGeneration = this.#admittedGeneration;
    if (this.#failed || this.#disposed || this.#completedGeneration >= targetGeneration) return;
    return new Promise((resolve) => {
      this.#flushWaiters.push({ targetGeneration, resolve });
    });
  }

  /** Publishes the current completed Xterm viewport without admitting bytes. */
  commitSnapshot(): void {
    if (this.#disposed || this.#failed || this.#publicationSuppressed()) return;
    this.#queueSnapshotRefresh(true);
    this.#materializeSnapshot();
  }

  resize(cols: number, rows: number): void {
    if (this.#disposed || this.#failed || (cols === this.cols && rows === this.rows)) return;
    try {
      this.#terminal.resize(cols, rows);
      this.#maxCellsSeen = Math.max(this.#maxCellsSeen, cols * rows);
      this.#queueSnapshotRefresh(!this.#publicationSuppressed());
    } catch {
      this.#disable();
    }
  }

  snapshot(): OutputSnapshot {
    this.#materializeSnapshot();
    const text = this.#lastAlternatePending
      ? this.#lastAlternateSnapshot
      : this.#snapshotActive ? this.#viewportSnapshot : "";
    return this.#snapshotText(text);
  }

  snapshotDelta(): OutputSnapshot {
    this.#materializeSnapshot();
    if (this.#lastAlternatePending) return this.#snapshotText(this.#lastAlternateSnapshot);
    if (this.#snapshotActive) {
      if (this.#generation === this.#deliveredGeneration) return this.#snapshotText("");
      return this.#snapshotText(this.#viewportSnapshot);
    }
    return this.#snapshotText("");
  }

  markDelivered(): void {
    if (this.#lastAlternatePending) {
      this.#lastAlternatePending = false;
      return;
    }
    if (this.#snapshotActive) this.#deliveredGeneration = this.#generation;
  }

  viewportLines(options: ViewportOptions = {}): string[] {
    const lines: string[] = [];
    const buffer = this.#terminal.buffer.active;
    const start = buffer.viewportY;
    for (let row = 0; row < this.rows; row += 1) {
      lines.push(this.#renderLine(
        buffer.getLine(start + row),
        options.ansi ?? true,
        options.pad ?? false,
        options.cursor && row === buffer.cursorY ? buffer.cursorX : -1,
      ));
    }
    return lines;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#responseImmediate) clearImmediate(this.#responseImmediate);
    this.#responseImmediate = undefined;
    this.#response = "";
    this.#pendingBytes = 0;
    this.#completedGeneration = this.#admittedGeneration;
    this.#completedOutOfOrder.clear();
    this.#writePublishability.clear();
    this.#deferredAlternate = undefined;
    this.#discardAlternateThroughGeneration = 0;
    this.#lastSuppressedGeneration = 0;
    this.#lastPublishableGeneration = 0;
    this.#lastAdmissionPublishable = true;
    this.#publicationBarrierGeneration = undefined;
    this.#resolveFlushWaiters();
    this.#notifyPressure();
    this.#pressureListeners.clear();
    this.#terminal.dispose();
  }

  #boundCellAttachments(data: string): string {
    const budget = this.#maxCellsSeen * TERMINAL_CELL_ATTACHMENT_BYTES_PER_CELL;
    const parts: string[] = [];
    let retainedStart = 0;
    let dropped = false;
    for (let index = 0; index < data.length;) {
      const codePoint = data.codePointAt(index)!;
      const value = String.fromCodePoint(codePoint);
      const next = index + value.length;
      if (isXtermUnicodeV6CellAttachment(codePoint)) {
        const bytes = utf8CodePointBytes(codePoint);
        if (this.#cellAttachmentBytes + bytes <= budget) {
          this.#cellAttachmentBytes += bytes;
        } else {
          if (retainedStart < index) parts.push(data.slice(retainedStart, index));
          this.#droppedCellAttachmentBytes += bytes;
          retainedStart = next;
          dropped = true;
        }
      }
      index = next;
    }
    if (!dropped) return data;
    if (retainedStart < data.length) parts.push(data.slice(retainedStart));
    return parts.join("");
  }

  #completeWrite(
    generation: number,
    bytes: number,
    publishSnapshot: boolean,
    discardLastAlternateSnapshot: boolean,
  ): void {
    if (this.#disposed || this.#failed) return;
    this.#pendingBytes = Math.max(0, this.#pendingBytes - bytes);
    this.#completedOutOfOrder.add(generation);
    while (this.#completedOutOfOrder.delete(this.#completedGeneration + 1)) {
      this.#completedGeneration += 1;
    }
    if (publishSnapshot) this.#lastPublishableGeneration = generation;
    this.#writePublishability.delete(generation);
    if (publishSnapshot && this.#deferredAlternate && generation > this.#deferredAlternate.generation) {
      this.#publishAlternateSnapshot(this.#deferredAlternate.snapshot);
      this.#deferredAlternate = undefined;
    }
    this.#queueSnapshotRefresh(publishSnapshot);
    if (
      this.#publicationBarrierGeneration !== undefined
      && this.#completedGeneration >= this.#publicationBarrierGeneration
    ) {
      // Xterm invokes each write callback before parsing the next queued write,
      // so this is the last safe point to capture a preceding publishable frame.
      this.#materializeSnapshot(true);
      this.#publicationBarrierGeneration = undefined;
    }
    if (discardLastAlternateSnapshot && !this.#alternateActive) {
      this.#discardAlternateSnapshotThrough(generation);
    }
    this.#resolveFlushWaiters();
    this.#notifyPressure();
  }

  #publishAlternateSnapshot(snapshot: string): void {
    this.#lastAlternatePending = !this.#snapshotActive
      || snapshot !== this.#viewportSnapshot
      || this.#generation !== this.#deliveredGeneration;
    this.#lastAlternateSnapshot = snapshot;
  }

  #disable(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#pendingBytes = 0;
    this.#completedGeneration = this.#admittedGeneration;
    this.#completedOutOfOrder.clear();
    this.#writePublishability.clear();
    this.#deferredAlternate = undefined;
    this.#discardAlternateThroughGeneration = 0;
    this.#lastSuppressedGeneration = 0;
    this.#lastPublishableGeneration = 0;
    this.#lastAdmissionPublishable = true;
    this.#publicationBarrierGeneration = undefined;
    this.#snapshotMode = false;
    this.#snapshotActive = false;
    this.#snapshotDirty = false;
    this.#viewportSnapshot = "";
    this.#lastAlternatePending = false;
    this.#lastAlternateSnapshot = "";
    this.#resolveFlushWaiters();
    this.#notifyPressure();
  }

  #publicationSuppressed(): boolean {
    return this.#lastSuppressedGeneration > this.#lastPublishableGeneration;
  }

  #resolveFlushWaiters(): void {
    if (this.#flushWaiters.length === 0) return;
    const pending: Array<{ targetGeneration: number; resolve(): void }> = [];
    for (const waiter of this.#flushWaiters) {
      if (this.#failed || this.#disposed || waiter.targetGeneration <= this.#completedGeneration) waiter.resolve();
      else pending.push(waiter);
    }
    this.#flushWaiters = pending;
  }

  #notifyPressure(): void {
    for (const listener of this.#pressureListeners) listener();
  }

  #queueSnapshotRefresh(publishSnapshot: boolean): void {
    if (this.#disposed || this.#failed) return;
    const alternateActive = this.#terminal.buffer.active.type === "alternate";
    this.#alternateActive = alternateActive;
    if (!publishSnapshot) return;
    const nextActive = alternateActive || this.#snapshotMode;
    if (!nextActive) {
      const changed = this.#snapshotActive || this.#viewportSnapshot !== "";
      this.#snapshotActive = false;
      this.#snapshotDirty = false;
      this.#viewportSnapshot = "";
      if (changed) this.#generation += 1;
      this.#onChange?.();
      return;
    }
    const wasDirty = this.#snapshotDirty;
    this.#snapshotDirty = true;
    // One notification opens the throttled presenter window. If a snapshot was
    // requested while later Xterm generations were still pending, notify once
    // more when the final admitted generation becomes safe to materialize.
    if (!wasDirty || this.#completedGeneration >= this.#admittedGeneration) this.#onChange?.();
  }

  #materializeSnapshot(atCompletedWriteBoundary = false): void {
    if (
      !this.#snapshotDirty
      || this.#disposed
      || this.#failed
      || (!atCompletedWriteBoundary && this.#completedGeneration < this.#admittedGeneration)
      || (!atCompletedWriteBoundary && this.#publicationSuppressed())
    ) return;
    const snapshotActive = this.#alternateActive || this.#snapshotMode;
    const next = snapshotActive ? this.#renderSnapshot() : "";
    const changed = snapshotActive !== this.#snapshotActive || next !== this.#viewportSnapshot;
    this.#snapshotActive = snapshotActive;
    this.#snapshotDirty = false;
    this.#viewportSnapshot = next;
    if (changed) this.#generation += 1;
  }

  #renderSnapshot(): string {
    this.#snapshotMaterializations += 1;
    const rendered = this.viewportLines({ ansi: true, pad: false });
    let start = 0;
    let end = rendered.length;
    while (start < end && rendered[start] === "") start += 1;
    while (end > start && rendered[end - 1] === "") end -= 1;
    return rendered.slice(start, end).join("\n");
  }

  #renderLine(line: IBufferLine | undefined, ansi: boolean, pad: boolean, cursorColumn: number): string {
    const reusable = line?.getCell(0);
    if (!reusable) return pad ? " ".repeat(this.cols) : "";
    let last = pad ? this.cols - 1 : -1;
    if (!pad) {
      for (let column = this.cols - 1; column >= 0; column -= 1) {
        line!.getCell(column, reusable);
        const cell = reusable;
        if (cell.getWidth() === 0) continue;
        const style = styleFromCell(cell);
        if (cell.getChars() || cellHasBackground(style) || column === cursorColumn) {
          last = column;
          break;
        }
      }
    }
    if (last < 0) return "";

    let output = "";
    let current = defaultStyle();
    for (let column = 0; column <= last; column += 1) {
      line!.getCell(column, reusable);
      const cell = reusable;
      if (cell.getWidth() === 0) continue;
      const next = styleFromCell(cell);
      if (column === cursorColumn) next.inverse = !next.inverse;
      const chars = next.hidden ? " " : (cell.getChars() || " ");
      if (ansi) output += transitionStyle(current, next);
      output += chars;
      current = next;
    }
    if (ansi) output += transitionStyle(current, defaultStyle());
    return output;
  }

  #snapshotText(text: string): OutputSnapshot {
    const snapshot = new HeadTailBuffer(OUTPUT_MAX_BYTES);
    if (text) snapshot.push(text);
    return snapshot.snapshot();
  }
}
