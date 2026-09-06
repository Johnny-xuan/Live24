const ESC = "\x1b";
const BEL = "\x07";

const STATE_GROUND = 0;
const STATE_ESCAPE = 1;
const STATE_CSI = 2;
const STATE_STRING = 3;
const STATE_STRING_ESCAPE = 4;

export const ECMA48_MAX_SEQUENCE_CHARS = 64;
export const ECMA48_MAX_STRING_PAYLOAD_BYTES = 64 * 1024;

const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

export type TranscriptEvent =
  | { type: "text"; text: string; sourceChars: number }
  | { type: "control"; value: string; sourceChars: number }
  | {
      type: "csi";
      sequence: string;
      body: string;
      final: string;
      hasPrivateMarker: boolean;
      hasIntermediate: boolean;
      sourceChars: number;
    }
  | { type: "escape"; sequence: string; final: string; sourceChars: number }
  | { type: "string"; sourceChars: number; overflowed: boolean; terminal?: string }
  | { type: "ignored"; sourceChars: number };

export interface Ecma48Frame {
  events: TranscriptEvent[];
  /** Complete, bounded records safe to forward to a terminal emulator. */
  terminal: string;
}

export function terminalTextForEvent(event: TranscriptEvent): string {
  if (event.type === "text") return event.text;
  if (event.type === "control") return event.value;
  if (event.type === "csi" || event.type === "escape") return event.sequence;
  if (event.type === "string") return event.terminal ?? "";
  return "";
}

export interface Ecma48FramerStats {
  state: "ground" | "escape" | "csi" | "string" | "string-escape";
  sequenceChars: number;
  stringPayloadBytes: number;
  stringOverflowed: boolean;
}

function isCsiParamByte(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

function isCsiIntermediateByte(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isPlainGroundCode(code: number): boolean {
  return code === 0x09 || (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f));
}

function isC1StringIntroducer(code: number): boolean {
  return code === C1_DCS || code === C1_SOS || code === C1_OSC || code === C1_PM || code === C1_APC;
}

function nearestStringControl(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x07 || code === 0x1b || code === C1_ST) return index;
  }
  return text.length;
}

/**
 * Incrementally frames decoded ECMA-48 input.
 *
 * Ground text is emitted immediately. Escape/CSI records are emitted only once
 * complete and are dropped after a small metadata bound. Terminal string
 * records (OSC/DCS/SOS/PM/APC) are buffered only up to a 64 KiB payload bound;
 * an overflowing record is consumed through its terminator but never forwarded
 * to Xterm or exposed as transcript text.
 */
export class Ecma48Framer {
  #state = STATE_GROUND;
  #escapeSequence = "";
  #escapeChars = 0;
  #escapeOverflowed = false;
  #csiIntroducer = "";
  #csiBody = "";
  #csiChars = 0;
  #csiHasPrivateMarker = false;
  #csiHasIntermediate = false;
  #csiOverflowed = false;
  #stringIntroducer = "";
  #stringParts: string[] = [];
  #stringPayloadBytes = 0;
  #stringSourceChars = 0;
  #stringOverflowed = false;
  #closed = false;

  write(chunk: string): Ecma48Frame {
    if (this.#closed || !chunk) return { events: [], terminal: "" };
    const events: TranscriptEvent[] = [];
    const terminal: string[] = [];
    let index = 0;

    while (index < chunk.length) {
      if (this.#state === STATE_STRING) {
        const control = nearestStringControl(chunk, index);
        if (control > index) {
          this.#appendStringPayload(chunk.slice(index, control));
          index = control;
          if (index >= chunk.length) break;
        }
        const code = chunk.charCodeAt(index);
        if (code === 0x07 || code === C1_ST) {
          const terminator = chunk[index]!;
          index += 1;
          this.#completeString(terminator, 1, events, terminal);
          continue;
        }
        // ESC can terminate as ST (ESC \\) or begin a fresh escape. Defer the
        // decision when the pair crosses a write boundary.
        if (index + 1 >= chunk.length) {
          this.#state = STATE_STRING_ESCAPE;
          index += 1;
          break;
        }
        if (chunk[index + 1] === "\\") {
          index += 2;
          this.#completeString(`${ESC}\\`, 2, events, terminal);
          continue;
        }
        this.#abortString(events);
        this.#startEscape();
        index += 1;
        continue;
      }

      if (this.#state === STATE_STRING_ESCAPE) {
        if (chunk[index] === "\\") {
          index += 1;
          this.#completeString(`${ESC}\\`, 2, events, terminal);
          continue;
        }
        this.#abortString(events);
        this.#startEscape();
        continue;
      }

      if (this.#state === STATE_GROUND) {
        const start = index;
        while (index < chunk.length && isPlainGroundCode(chunk.charCodeAt(index))) index += 1;
        if (index > start) {
          const text = chunk.slice(start, index);
          events.push({ type: "text", text, sourceChars: text.length });
          terminal.push(text);
          continue;
        }
      }

      const codePoint = chunk.codePointAt(index)!;
      const value = String.fromCodePoint(codePoint);
      const code = value.charCodeAt(0);
      index += value.length;

      if (this.#state === STATE_GROUND) {
        if (value === ESC) {
          this.#startEscape();
        } else if (code === C1_CSI) {
          this.#startCsi(value);
        } else if (isC1StringIntroducer(code)) {
          this.#startString(value);
        } else {
          events.push({ type: "control", value, sourceChars: value.length });
          terminal.push(value);
        }
        continue;
      }

      if (this.#state === STATE_ESCAPE) {
        if (value === ESC) {
          if (this.#escapeChars > 0) events.push({ type: "ignored", sourceChars: this.#escapeChars });
          this.#startEscape();
          continue;
        }
        if (value === "[") {
          this.#startCsi(`${ESC}[`);
          continue;
        }
        if (value === "]" || value === "P" || value === "X" || value === "^" || value === "_") {
          this.#startString(`${ESC}${value}`);
          continue;
        }
        this.#appendEscape(value);
        if (isCsiIntermediateByte(code)) continue;
        if (code >= 0x30 && code <= 0x7e) {
          const sourceChars = this.#escapeChars;
          if (this.#escapeOverflowed) {
            events.push({ type: "ignored", sourceChars });
          } else {
            events.push({
              type: "escape",
              sequence: this.#escapeSequence,
              final: value,
              sourceChars,
            });
            terminal.push(this.#escapeSequence);
          }
          this.#resetGround();
        } else {
          events.push({ type: "ignored", sourceChars: this.#escapeChars });
          this.#resetGround();
        }
        continue;
      }

      if (this.#state === STATE_CSI) {
        if (isCsiParamByte(code)) {
          if (code >= 0x3c && code <= 0x3f) this.#csiHasPrivateMarker = true;
          this.#appendCsi(value);
          continue;
        }
        if (isCsiIntermediateByte(code)) {
          this.#csiHasIntermediate = true;
          this.#appendCsi(value);
          continue;
        }
        if (isCsiFinalByte(code)) {
          const sourceChars = this.#csiIntroducer.length + this.#csiChars + value.length;
          if (this.#csiOverflowed) {
            events.push({ type: "ignored", sourceChars });
          } else {
            const sequence = `${this.#csiIntroducer}${this.#csiBody}${value}`;
            events.push({
              type: "csi",
              sequence,
              body: this.#csiBody,
              final: value,
              hasPrivateMarker: this.#csiHasPrivateMarker,
              hasIntermediate: this.#csiHasIntermediate,
              sourceChars,
            });
            terminal.push(sequence);
          }
          this.#resetGround();
          continue;
        }

        const sourceChars = this.#csiIntroducer.length + this.#csiChars;
        if (sourceChars > 0) events.push({ type: "ignored", sourceChars });
        this.#resetGround();
        if (value === ESC) this.#startEscape();
        else {
          events.push({ type: "control", value, sourceChars: value.length });
          terminal.push(value);
        }
      }
    }

    return { events, terminal: terminal.join("") };
  }

  end(): Ecma48Frame {
    if (this.#closed) return { events: [], terminal: "" };
    this.#closed = true;
    const events: TranscriptEvent[] = [];
    if (this.#state === STATE_ESCAPE && this.#escapeChars > 0) {
      events.push({ type: "ignored", sourceChars: this.#escapeChars });
    } else if (this.#state === STATE_CSI) {
      events.push({ type: "ignored", sourceChars: this.#csiIntroducer.length + this.#csiChars });
    } else if (this.#state === STATE_STRING || this.#state === STATE_STRING_ESCAPE) {
      const pendingEsc = this.#state === STATE_STRING_ESCAPE ? 1 : 0;
      events.push({
        type: "string",
        sourceChars: this.#stringSourceChars + pendingEsc,
        overflowed: this.#stringOverflowed,
      });
    }
    this.#resetGround();
    return { events, terminal: "" };
  }

  stats(): Ecma48FramerStats {
    const names = ["ground", "escape", "csi", "string", "string-escape"] as const;
    return {
      state: names[this.#state]!,
      sequenceChars: this.#state === STATE_CSI ? this.#csiBody.length : this.#escapeSequence.length,
      stringPayloadBytes: this.#stringPayloadBytes,
      stringOverflowed: this.#stringOverflowed,
    };
  }

  #startEscape(): void {
    this.#state = STATE_ESCAPE;
    this.#escapeSequence = ESC;
    this.#escapeChars = 1;
    this.#escapeOverflowed = false;
  }

  #appendEscape(value: string): void {
    this.#escapeChars += value.length;
    if (this.#escapeSequence.length + value.length <= ECMA48_MAX_SEQUENCE_CHARS) {
      this.#escapeSequence += value;
    } else {
      this.#escapeOverflowed = true;
    }
  }

  #startCsi(introducer: string): void {
    this.#state = STATE_CSI;
    this.#csiIntroducer = introducer;
    this.#csiBody = "";
    this.#csiChars = 0;
    this.#csiHasPrivateMarker = false;
    this.#csiHasIntermediate = false;
    this.#csiOverflowed = false;
  }

  #appendCsi(value: string): void {
    this.#csiChars += value.length;
    // Reserve the introducer and one final byte inside the total sequence cap.
    const bodyLimit = Math.max(0, ECMA48_MAX_SEQUENCE_CHARS - this.#csiIntroducer.length - 1);
    if (this.#csiBody.length + value.length <= bodyLimit) {
      this.#csiBody += value;
    } else {
      this.#csiOverflowed = true;
    }
  }

  #startString(introducer: string): void {
    this.#state = STATE_STRING;
    this.#stringIntroducer = introducer;
    this.#stringParts = [];
    this.#stringPayloadBytes = 0;
    this.#stringSourceChars = introducer.length;
    this.#stringOverflowed = false;
  }

  #appendStringPayload(text: string): void {
    if (!text) return;
    this.#stringSourceChars += text.length;
    if (this.#stringOverflowed) return;
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.#stringPayloadBytes + bytes > ECMA48_MAX_STRING_PAYLOAD_BYTES) {
      this.#stringOverflowed = true;
      this.#stringParts.length = 0;
      this.#stringPayloadBytes = 0;
      return;
    }
    this.#stringParts.push(text);
    this.#stringPayloadBytes += bytes;
  }

  #completeString(
    terminator: string,
    terminatorChars: number,
    events: TranscriptEvent[],
    terminal: string[],
  ): void {
    const sourceChars = this.#stringSourceChars + terminatorChars;
    const terminalRecord = this.#stringOverflowed
      ? undefined
      : `${this.#stringIntroducer}${this.#stringParts.join("")}${terminator}`;
    events.push({ type: "string", sourceChars, overflowed: this.#stringOverflowed, ...(terminalRecord ? { terminal: terminalRecord } : {}) });
    if (terminalRecord) terminal.push(terminalRecord);
    this.#resetGround();
  }

  #abortString(events: TranscriptEvent[]): void {
    events.push({
      type: "string",
      sourceChars: this.#stringSourceChars,
      overflowed: this.#stringOverflowed,
    });
    this.#resetGround();
  }

  #resetGround(): void {
    this.#state = STATE_GROUND;
    this.#escapeSequence = "";
    this.#escapeChars = 0;
    this.#escapeOverflowed = false;
    this.#csiIntroducer = "";
    this.#csiBody = "";
    this.#csiChars = 0;
    this.#csiHasPrivateMarker = false;
    this.#csiHasIntermediate = false;
    this.#csiOverflowed = false;
    this.#stringIntroducer = "";
    this.#stringParts.length = 0;
    this.#stringPayloadBytes = 0;
    this.#stringSourceChars = 0;
    this.#stringOverflowed = false;
  }
}

export { BEL, ESC };
