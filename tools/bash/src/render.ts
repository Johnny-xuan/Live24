import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeAnsiSync } from "./output/ansi-sanitizer.js";
import { compactOutputForTool } from "./output/presenter.js";
import type { UnifiedExecDetails } from "./protocol.js";
import { parseSgrParameters } from "./output/sgr.js";

function sgrLeavesDefaultBackground(body: string): boolean {
  const values = parseSgrParameters(body);
  let background: "unchanged" | "default" | "explicit" = "unchanged";
  for (let index = 0; index < values.length; index += 1) {
    const value = Number.isFinite(values[index]) ? values[index]! : 0;
    if (value === 0 || value === 49) background = "default";
    else if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) background = "explicit";
    else if (value === 48 && index + 1 < values.length) {
      const mode = values[index + 1];
      if (mode === 5 && index + 2 < values.length) {
        background = "explicit";
        index += 2;
      } else if (mode === 2 && index + 4 < values.length) {
        background = "explicit";
        index += 4;
      }
    }
  }
  return background === "default";
}

/** Restore Pi's containing tool Box after child SGR resets its background. */
export function rebaseAnsiBackground(output: string, parentBackground: string): string {
  if (!parentBackground || !output.includes("\x1b[")) return output;
  return output.replace(/\x1b\[([0-9;:]*)m/g, (sequence, body: string) =>
    sgrLeavesDefaultBackground(body) ? `${sequence}${parentBackground}` : sequence,
  );
}

function parentToolBackground(
  theme: Theme,
  options: { isPartial: boolean },
  context?: { isError?: boolean },
): string {
  const token = options.isPartial ? "toolPendingBg" : context?.isError ? "toolErrorBg" : "toolSuccessBg";
  const getBgAnsi = (theme as Theme & { getBgAnsi?: (name: string) => string }).getBgAnsi;
  return typeof getBgAnsi === "function" ? getBgAnsi.call(theme, token) : "";
}

export function renderExecCall(args: Record<string, unknown>, theme: Theme): Text {
  const cmd = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "…";
  const workdir = typeof args.workdir === "string" ? ` @ ${args.workdir}` : "";
  const tty = args.tty === true ? " [tty]" : "";
  return new Text(theme.fg("toolTitle", theme.bold(`$ ${cmd}${workdir}${tty}`)), 0, 0);
}

export function renderWriteCall(args: Record<string, unknown>, theme: Theme): Text {
  const id = typeof args.session_id === "number" ? args.session_id : "?";
  const chars = typeof args.chars === "string" ? args.chars : "";
  const action = chars === "" ? "poll" : chars === "\u0003" ? "Ctrl-C" : `write ${JSON.stringify(chars)}`;
  return new Text(theme.fg("toolTitle", theme.bold(`session ${id}: ${action}`)), 0, 0);
}

export function renderExecResult(
  result: {
    content: ReadonlyArray<{ type: string; text?: string }>;
    details?: UnifiedExecDetails;
  },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context?: { isError?: boolean },
): Text {
  const parentBackground = parentToolBackground(theme, options, context);
  const details = result.details;
  if (!details) {
    const message = result.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    const output = rebaseAnsiBackground(compactOutputForTool(message || "Unified Exec returned no details", options.expanded), parentBackground);
    return new Text(theme.fg("warning", output), 0, 0);
  }
  const state = options.isPartial || details.status === "streaming"
    ? theme.fg("warning", "streaming")
    : details.status === "running"
      ? theme.fg("accent", `running #${details.session_id}`)
      : details.exit_code === 0
        ? theme.fg("success", "exited 0")
        : theme.fg("warning", `exited ${details.exit_code ?? "?"}`);
  const artifact = details.output_artifact ? theme.fg("dim", `\nartifact: ${details.output_artifact.path}`) : "";
  // Belt-and-suspenders: even though the process layer sanitizes on ingestion,
  // never let non-SGR sequences reach the TUI renderer.
  const output = rebaseAnsiBackground(
    compactOutputForTool(sanitizeAnsiSync(details.output), options.expanded),
    parentBackground,
  );
  return new Text(`${state}${output ? `\n${theme.fg("toolOutput", output)}` : ""}${artifact}`, 0, 0);
}
