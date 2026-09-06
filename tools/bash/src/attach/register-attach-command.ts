import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager, ProcessSummary } from "../runtime/process-manager.js";
import { buildAttachHandoff, resolveHandoffDelivery, type AttachHandoffMode } from "./handoff.js";
import { TerminalAttachOverlay } from "./terminal-attach-overlay.js";

function sessionLabel(summary: ProcessSummary): string {
  const command = summary.command.at(-1)?.replace(/\s+/g, " ").trim() || summary.command.join(" ");
  const state = summary.attached ? "attached" : summary.exited ? "exited" : "running";
  const size = summary.cols && summary.rows ? ` ${summary.cols}×${summary.rows}` : "";
  const clipped = command.length > 72 ? `${command.slice(0, 69)}...` : command;
  return `${summary.session_id} [${state}${size}] ${clipped}`;
}

function parseSessionId(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function registerAttachCommand(
  pi: ExtensionAPI,
  getManager: () => Promise<ProcessManager>,
): void {
  pi.registerCommand("bash-attach", {
    description: "Attach to a managed Bash PTY session; omit the ID to open the session panel",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("Bash attachment requires Pi TUI mode.", "warning");
        return;
      }

      const manager = await getManager();
      const requested = args.trim();
      let sessionId: number | undefined;
      if (requested) {
        const parts = requested.split(/\s+/);
        if (parts.length !== 1 || (sessionId = parseSessionId(parts[0]!)) === undefined) {
          ctx.ui.notify("Usage: /bash-attach [session_id]", "warning");
          return;
        }
      } else {
        const sessions = manager.list().filter((entry) => entry.tty && !entry.exited);
        if (sessions.length === 0) {
          ctx.ui.notify("No live managed Bash PTY sessions.", "info");
          return;
        }
        const labels = sessions.map(sessionLabel);
        const selected = await ctx.ui.select("Attach to Bash session", labels);
        if (!selected) return;
        sessionId = parseSessionId(selected.split(/\s+/, 1)[0]!);
      }
      if (sessionId === undefined) return;

      let attachment;
      try {
        attachment = manager.attach(sessionId);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "warning");
        return;
      }

      let mode: AttachHandoffMode | undefined;
      try {
        mode = await ctx.ui.custom<AttachHandoffMode | undefined>(
          (tui, theme, _keybindings, done) => new TerminalAttachOverlay({
            tui,
            theme,
            attachment,
            done,
          }),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "95%",
              minWidth: 40,
              maxHeight: "90%",
            },
          },
        );
      } finally {
        attachment.release();
      }

      if (!mode) return;
      const status = {
        sessionId,
        status: attachment.exited ? "exited" as const : "running" as const,
        exitCode: attachment.exitCode,
      };
      pi.appendEntry("pi-bash-attach", {
        ...status,
        detachedAt: new Date().toISOString(),
        handoff: mode,
      });
      const delivery = resolveHandoffDelivery(mode);
      if (delivery) pi.sendMessage(buildAttachHandoff(status), delivery);
      ctx.ui.notify(
        mode === "none" ? `Detached from Bash session ${sessionId}.` : `Detached from Bash session ${sessionId}; Agent notified (${mode}).`,
        "info",
      );
    },
  });
}
