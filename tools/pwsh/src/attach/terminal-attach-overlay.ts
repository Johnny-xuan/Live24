import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProcessAttachment } from "../runtime/process-manager.js";
import type { AttachHandoffMode } from "./handoff.js";

const HANDOFF_KEY = "ctrl+shift+h";
const SHELL_LABEL = process.platform === "win32" ? "PowerShell" : "Bash";

type MenuChoice = AttachHandoffMode | "cancel";

interface OverlayMouseEvent {
  type: "press" | "release" | "move" | "drag" | "click" | "wheel";
  button: "left" | "middle" | "right" | "none";
  x: number;
  y: number;
}

interface OverlayMouseResult {
  handled: true;
  render?: boolean;
}

const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  separatorLeft: "├",
  separatorRight: "┤",
};

export interface TerminalAttachOverlayOptions {
  tui: TUI;
  theme: Theme;
  attachment: ProcessAttachment;
  done: (mode: AttachHandoffMode | undefined) => void;
}

/** User-only terminal panel over an existing ProcessManager PTY. */
export class TerminalAttachOverlay implements Component, Focusable {
  focused = false;
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #attachment: ProcessAttachment;
  readonly #done: (mode: AttachHandoffMode | undefined) => void;
  #menuOpen = false;
  #menuSelection: MenuChoice = "none";
  #finished = false;
  #lastCols = 0;
  #lastRows = 0;
  #closeHitbox?: { startX: number; endX: number; y: number };
  #renderTimer?: NodeJS.Timeout;
  #unsubscribe: () => void;

  constructor(options: TerminalAttachOverlayOptions) {
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#attachment = options.attachment;
    this.#done = options.done;
    this.#unsubscribe = this.#attachment.subscribe(() => this.#scheduleRender());
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    if (this.#menuOpen) {
      this.#handleMenuInput(data);
      return;
    }
    if (this.#attachment.exited && matchesKey(data, "escape")) {
      this.#finish("none");
      return;
    }
    if (matchesKey(data, HANDOFF_KEY)) {
      this.#menuOpen = true;
      this.#menuSelection = "none";
      this.#tui.requestRender();
      return;
    }
    if (!this.#attachment.exited) this.#attachment.write(data);
  }

  handleMouse(event: OverlayMouseEvent): OverlayMouseResult | undefined {
    if (this.#finished || event.button !== "left" || !this.#isCloseHit(event.x, event.y)) return undefined;
    if (event.type === "press" || event.type === "release") return { handled: true, render: false };
    if (event.type !== "click") return undefined;
    this.#finish("none");
    return { handled: true, render: false };
  }

  render(width: number): string[] {
    const panelWidth = Math.max(20, width);
    const innerWidth = Math.max(1, panelWidth - 2);
    const choices = this.#menuChoices();
    const footerRows = this.#menuOpen ? choices.length + 2 : 2;
    const targetHeight = Math.max(10, Math.floor(this.#tui.terminal.rows * 0.9));
    const chromeRows = 6 + footerRows;
    const terminalRows = Math.max(3, targetHeight - chromeRows);

    if (innerWidth !== this.#lastCols || terminalRows !== this.#lastRows) {
      this.#lastCols = innerWidth;
      this.#lastRows = terminalRows;
      if (!this.#attachment.exited) this.#attachment.resize({ cols: innerWidth, rows: terminalRows });
    }

    const border = (text: string) => this.#theme.fg(this.focused ? "borderAccent" : "borderMuted", text);
    const row = (content: string): string => {
      const clipped = truncateToWidth(content, innerWidth, "");
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return border(BORDER.vertical) + clipped + padding + border(BORDER.vertical);
    };
    const separator = border(BORDER.separatorLeft + BORDER.horizontal.repeat(innerWidth) + BORDER.separatorRight);
    const lines: string[] = [border(BORDER.topLeft + BORDER.horizontal.repeat(innerWidth) + BORDER.topRight)];

    const command = this.#attachment.command.at(-1)?.replace(/\s+/g, " ").trim() || this.#attachment.command.join(" ");
    const status = this.#attachment.exited
      ? this.#theme.fg(this.#attachment.exitCode === 0 ? "success" : "warning", `exited ${this.#attachment.exitCode ?? "?"}`)
      : this.#theme.fg("success", "user attached");
    const title = this.#theme.fg("accent", this.#theme.bold(` ${SHELL_LABEL} #${this.#attachment.session_id} `));
    const meta = ` ${status} `;
    const closeControl = "[Close]";
    const handoffControl = "[Ctrl+Shift+H Handoff]";
    const fullControls = ` ${handoffControl} ${closeControl} `;
    const compactControls = ` ${closeControl} `;
    const controlsText = innerWidth >= visibleWidth(title) + visibleWidth(meta) + visibleWidth(fullControls)
      ? fullControls
      : compactControls;
    const visibleMeta = innerWidth >= visibleWidth(title) + visibleWidth(meta) + visibleWidth(controlsText) ? meta : "";
    const titleFill = " ".repeat(
      Math.max(0, innerWidth - visibleWidth(title) - visibleWidth(visibleMeta) - visibleWidth(controlsText)),
    );
    const controlsStart = visibleWidth(title) + visibleWidth(titleFill) + visibleWidth(visibleMeta);
    const closeStart = 1 + controlsStart + controlsText.indexOf(closeControl);
    this.#closeHitbox = { startX: closeStart, endX: closeStart + closeControl.length, y: 1 };
    lines.push(row(title + titleFill + visibleMeta + this.#theme.fg("accent", controlsText)));
    lines.push(row(this.#theme.fg("dim", truncateToWidth(`${command} — ${this.#attachment.workdir}`, innerWidth, "…"))));
    lines.push(separator);

    const viewport = this.#attachment.viewportLines({ ansi: true, cursor: !this.#attachment.exited, pad: true });
    for (let index = 0; index < terminalRows; index += 1) {
      lines.push(row(viewport[index] ?? ""));
    }
    lines.push(separator);

    if (this.#menuOpen) {
      lines.push(row(this.#theme.fg("accent", " Detach and hand off:")));
      for (const choice of choices) {
        const selected = choice.key === this.#menuSelection;
        const prefix = selected ? this.#theme.fg("accent", " ▶ ") : "   ";
        const label = selected ? this.#theme.fg("accent", choice.label) : choice.label;
        lines.push(row(prefix + label));
      }
      const escapeHint = this.#attachment.exited ? "Esc return" : "Esc cancel";
      lines.push(row(this.#theme.fg("dim", ` ↑↓ select • Enter confirm • ${escapeHint}`)));
    } else if (this.#attachment.exited) {
      lines.push(row(this.#theme.fg("warning", " Process exited • Esc close • Ctrl+Shift+H handoff")));
      lines.push(row(this.#theme.fg("dim", " Input is read-only")));
    } else {
      lines.push(row(this.#theme.fg("dim", " Exclusive user control • Ctrl+Shift+H handoff")));
      lines.push(row(this.#theme.fg("dim", ` ${this.#lastCols}×${this.#lastRows} • input is not logged by pwsh`)));
    }

    lines.push(border(BORDER.bottomLeft + BORDER.horizontal.repeat(innerWidth) + BORDER.bottomRight));
    return lines;
  }

  invalidate(): void {
    this.#lastCols = 0;
    this.#lastRows = 0;
    this.#closeHitbox = undefined;
  }

  dispose(): void {
    this.#finish(undefined);
  }

  #isCloseHit(x: number, y: number): boolean {
    const hitbox = this.#closeHitbox;
    return hitbox !== undefined && y === hitbox.y && x >= hitbox.startX && x < hitbox.endX;
  }

  #menuChoices(): Array<{ key: MenuChoice; label: string }> {
    const choices: Array<{ key: MenuChoice; label: string }> = [
      { key: "none", label: "Return to Pi without notifying Agent" },
      { key: "queued", label: "Return and queue a follow-up notification" },
      { key: "steering", label: "Return and steer Agent at the next safe boundary" },
    ];
    if (!this.#attachment.exited) choices.push({ key: "cancel", label: "Cancel and continue terminal interaction" });
    return choices;
  }

  #handleMenuInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.#attachment.exited) this.#finish("none");
      else {
        this.#menuOpen = false;
        this.#tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const choices = this.#menuChoices();
      const index = choices.findIndex((choice) => choice.key === this.#menuSelection);
      const direction = matchesKey(data, "up") ? -1 : 1;
      this.#menuSelection = choices[(index + direction + choices.length) % choices.length]!.key;
      this.#tui.requestRender();
      return;
    }
    if (!matchesKey(data, "enter")) return;
    if (this.#menuSelection === "cancel") {
      this.#menuOpen = false;
      this.#tui.requestRender();
      return;
    }
    this.#finish(this.#menuSelection);
  }

  #scheduleRender(): void {
    if (this.#finished || this.#renderTimer) return;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = undefined;
      this.#tui.requestRender();
    }, 16);
  }

  #finish(mode: AttachHandoffMode | undefined): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
    this.#renderTimer = undefined;
    this.#unsubscribe();
    this.#attachment.release();
    this.#done(mode);
  }
}

export const ATTACH_HANDOFF_KEY = HANDOFF_KEY;
