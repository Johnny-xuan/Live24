import type { BashToolDetails, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BashParams,
  formatDetails,
  resolveBashInput,
  WriteStdinParams,
  type BashInput,
  type UnifiedExecDetails,
} from "./protocol.js";
import { registerAttachCommand } from "./attach/register-attach-command.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { renderExecCall, renderExecResult, renderWriteCall } from "./render.js";
import { ProcessManager, type ManagerCallContext } from "./runtime/process-manager.js";
import { hostToolTerminalSize } from "./runtime/terminal-size.js";

type BashUnifiedExecDetails = UnifiedExecDetails & BashToolDetails;

function asBashDetails(details: UnifiedExecDetails): BashUnifiedExecDetails {
  return {
    ...details,
    ...(details.output_artifact ? { fullOutputPath: details.output_artifact.path } : {}),
  };
}

function sessionEnvironment(ctx: ExtensionContext) {
  const model = ctx.model;
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    provider: model?.provider,
    model: model?.id,
    reasoningLevel: ctx.thinkingLevel,
  };
}

export default function unifiedExecExtension(pi: ExtensionAPI): void {
  let managerPromise: Promise<ProcessManager> | undefined;
  let removeResizeListener: (() => void) | undefined;

  const getManager = (): Promise<ProcessManager> => {
    managerPromise ??= ProcessManager.create();
    return managerPromise;
  };

  const shutdownManager = async (): Promise<void> => {
    removeResizeListener?.();
    removeResizeListener = undefined;
    const current = managerPromise;
    managerPromise = undefined;
    if (current) await (await current).shutdown();
  };

  const watchHostTerminalSize = (): void => {
    removeResizeListener?.();
    removeResizeListener = undefined;
    if (!process.stdout.isTTY) return;
    const onResize = () => {
      const size = hostToolTerminalSize();
      const current = managerPromise;
      if (!size || !current) return;
      void current.then((manager) => manager.resizePtys(size)).catch(() => undefined);
    };
    process.stdout.on("resize", onResize);
    removeResizeListener = () => process.stdout.off("resize", onResize);
  };

  const callContext = (
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: ManagerCallContext["onUpdate"],
    timeoutMs?: number,
  ): ManagerCallContext => ({
    cwd: ctx.cwd,
    signal,
    sessionEnvironment: sessionEnvironment(ctx),
    onUpdate,
    timeoutMs,
    terminalSize: ctx.mode === "tui" ? hostToolTerminalSize() : undefined,
  });

  registerAttachCommand(pi, getManager);

  pi.on("session_start", async () => {
    await shutdownManager();
    await getManager();
    watchHostTerminalSize();
  });

  pi.on("session_shutdown", async () => {
    await shutdownManager();
  });

  pi.registerTool({
    name: "bash",
    label: "Bash (Unified Exec)",
    description: "Execute shell commands with optional explicit workdir, hard timeout, managed background sessions, and PTY interaction. Long commands yield a session for write_stdin; interactive full-screen PTYs return a bounded latest terminal viewport.",
    promptSnippet: "Execute shell commands, including Git, search, build, tests, file inspection, background processes, and interactive PTY programs",
    promptGuidelines: [
      "Use bash for all shell execution, including Git, search, build, tests, and file inspection.",
      "Use bash with tty=true for prompts, REPLs, editors, and full-screen terminal applications, then continue the returned session with write_stdin.",
      "When a bash PTY needs a password, private value, or direct human judgment, never request the value in chat; ask the user to run /bash-attach <session_id>, stop model input while attached, and resume with write_stdin after the detach handoff.",
      "Use bash workdir instead of prefixing commands with cd when the target directory is known.",
      "You can inspect PI_* environment variables for current model and session details.",
    ],
    parameters: BashParams,
    prepareArguments(args): BashInput {
      if (!args || typeof args !== "object") return args as BashInput;
      const legacy = args as Record<string, unknown>;
      if (typeof legacy.cmd !== "string" || legacy.command !== undefined) return args as BashInput;
      const { cmd, ...rest } = legacy;
      return { ...rest, command: cmd } as BashInput;
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const manager = await getManager();
      const { execInput, timeoutMs } = resolveBashInput(params);
      const details = await manager.execCommand(execInput, callContext(ctx, signal, (partial) => {
        const compatible = asBashDetails(partial);
        onUpdate?.({ content: [{ type: "text", text: formatDetails(compatible) }], details: compatible });
      }, timeoutMs));
      const compatible = asBashDetails(details);
      return { content: [{ type: "text", text: formatDetails(compatible) }], details: compatible };
    },
    renderCall: (args, theme) => renderExecCall(args, theme),
    renderResult: (result, options, theme, context) => renderExecResult(result as { content: Array<{ type: string; text?: string }>; details?: BashUnifiedExecDetails }, options, theme, context),
  });

  pi.registerTool({
    name: "write_stdin",
    label: "Write Stdin",
    description: "Poll or interact with a live managed bash session. Empty chars polls; input is exact and no newline is appended. Active full-screen programs return the latest bounded viewport rather than redraw history.",
    promptSnippet: "Poll or send exact input to a live managed Bash/PTTY session and read its latest bounded terminal output",
    promptGuidelines: [
      "Use write_stdin only with a live session_id returned by bash; empty chars polls without input, and non-empty chars is written exactly with no implicit newline.",
      "When write_stdin returns a latest full-screen viewport, treat it as the current replacement screen rather than appended history; send the smallest relevant input and poll again.",
      "If write_stdin reports that the user has attached to the session, do not retry or race the user; wait for the detach handoff before continuing.",
    ],
    parameters: WriteStdinParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const manager = await getManager();
      const details = await manager.writeStdin(params, {
        signal,
        sessionEnvironment: sessionEnvironment(ctx),
        onUpdate: (partial) => onUpdate?.({ content: [{ type: "text", text: formatDetails(partial) }], details: partial }),
      });
      return { content: [{ type: "text", text: formatDetails(details) }], details };
    },
    renderCall: (args, theme) => renderWriteCall(args, theme),
    renderResult: (result, options, theme, context) => renderExecResult(result as { content: Array<{ type: string; text?: string }>; details?: UnifiedExecDetails }, options, theme, context),
  });

  pi.registerCommand("unified-exec-doctor", {
    description: "Report Unified Exec shell, PTY, process-tree, and artifact diagnostics",
    handler: async (_args, ctx) => {
      const report = await runDoctor(await getManager());
      const active = pi.getActiveTools();
      const bash = pi.getAllTools().find((tool) => tool.name === "bash");
      const surface = [
        `Bash override: ${bash?.sourceInfo.source ?? "missing"} (${bash?.sourceInfo.path ?? "unknown"})`,
        `Active tools: bash=${active.includes("bash")}, write_stdin=${active.includes("write_stdin")}, exec_command=${active.includes("exec_command")}`,
      ].join("\n");
      ctx.ui.notify(`${formatDoctor(report)}\n${surface}`, report.status === "ok" ? "info" : "warning");
    },
  });
}

export { ProcessManager } from "./runtime/process-manager.js";
export * from "./protocol.js";
