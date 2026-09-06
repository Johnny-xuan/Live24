import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatDetails,
  resolveSuperShellInput,
  SuperShellParams,
  WriteStdinParams,
  type SuperShellInput,
  type UnifiedExecDetails,
} from "./protocol.js";
import { registerAttachCommand } from "./attach/register-attach-command.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { renderExecCall, renderExecResult, renderWriteCall } from "./render.js";
import { ProcessManager, type ManagerCallContext } from "./runtime/process-manager.js";
import { hostToolTerminalSize } from "./runtime/terminal-size.js";

type CompatibleShellDetails = UnifiedExecDetails & { fullOutputPath?: string };

const WINDOWS_NATIVE = process.platform === "win32";
const PRIMARY_TOOL_NAME = WINDOWS_NATIVE ? "powershell" : "bash";
const PRIMARY_TOOL_LABEL = WINDOWS_NATIVE ? "PowerShell 7 (pwsh)" : "Bash (pwsh)";
const ATTACH_COMMAND = WINDOWS_NATIVE ? "powershell-attach" : "bash-attach";

function asCompatibleDetails(details: UnifiedExecDetails): CompatibleShellDetails {
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
    shellPreference: process.platform === "win32" ? "powershell" : "legacy",
    nativePowerShell: process.platform === "win32",
    windowsYieldFloor: process.platform !== "win32",
  });

  registerAttachCommand(pi, getManager, {
    commandName: ATTACH_COMMAND,
    aliases: WINDOWS_NATIVE ? ["bash-attach"] : [],
    shellLabel: WINDOWS_NATIVE ? "PowerShell" : "Bash",
  });

  pi.on("session_start", async () => {
    await shutdownManager();
    await getManager();
    watchHostTerminalSize();
  });

  pi.on("session_shutdown", async () => {
    await shutdownManager();
  });

  pi.registerTool({
    name: PRIMARY_TOOL_NAME,
    label: PRIMARY_TOOL_LABEL,
    description: WINDOWS_NATIVE
      ? "Run PowerShell 7 scripts or spawn native executables with exact argv. Supports explicit workdirs, hard timeouts, managed background sessions, writable ConPTY sessions, latest-screen TUI projection, and write_stdin continuation. Provide exactly one of command or executable."
      : "Run shell scripts or spawn native executables with exact argv. Supports explicit workdirs, hard timeouts, managed background sessions, writable PTYs, latest-screen TUI projection, and write_stdin continuation. Provide exactly one of command or executable.",
    promptSnippet: WINDOWS_NATIVE
      ? "Execute PowerShell 7 scripts or native Windows executables with managed background and ConPTY sessions"
      : "Execute shell scripts or native executables with managed background and PTY sessions",
    promptGuidelines: WINDOWS_NATIVE ? [
      "Use powershell command mode for PowerShell syntax and executable/args mode when exact native argv avoids quoting ambiguity.",
      "Use powershell with tty=true for prompts, REPLs, and full-screen terminal applications, then continue the returned session with write_stdin.",
      `When a powershell PTY needs a password, private value, or direct human judgment, ask the user to run /${ATTACH_COMMAND} <session_id>; never request the value in chat.`,
      "Use powershell workdir instead of prefixing commands with Set-Location when the target directory is known.",
      "PowerShell profiles are disabled by default for Agent commands; set login=true only when profile semantics are explicitly required.",
      "You can inspect PI_* environment variables for current model and session details.",
    ] : [
      "Use bash command mode for shell syntax and executable/args mode when exact native argv avoids quoting ambiguity.",
      "Use bash with tty=true for prompts, REPLs, and full-screen terminal applications, then continue the returned session with write_stdin.",
      `When a bash PTY needs a password, private value, or direct human judgment, ask the user to run /${ATTACH_COMMAND} <session_id>; never request the value in chat.`,
      "Use bash workdir instead of prefixing commands with cd when the target directory is known.",
      "You can inspect PI_* environment variables for current model and session details.",
    ],
    parameters: SuperShellParams,
    prepareArguments(args): SuperShellInput {
      if (!args || typeof args !== "object") return args as SuperShellInput;
      const legacy = args as Record<string, unknown>;
      if (typeof legacy.cmd !== "string" || legacy.command !== undefined) return args as SuperShellInput;
      const { cmd, ...rest } = legacy;
      return { ...rest, command: cmd } as SuperShellInput;
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const manager = await getManager();
      const resolved = resolveSuperShellInput(params);
      const managerContext = callContext(ctx, signal, (partial) => {
        const compatible = asCompatibleDetails(partial);
        onUpdate?.({ content: [{ type: "text", text: formatDetails(compatible) }], details: compatible });
      }, resolved.timeoutMs);
      const details = resolved.kind === "native"
        ? await manager.execNative(resolved.execInput, managerContext)
        : await manager.execCommand(resolved.execInput, managerContext);
      const compatible = asCompatibleDetails(details);
      return { content: [{ type: "text", text: formatDetails(compatible) }], details: compatible };
    },
    renderCall: (args, theme) => renderExecCall(args, theme),
    renderResult: (result, options, theme, context) => renderExecResult(result as { content: Array<{ type: string; text?: string }>; details?: CompatibleShellDetails }, options, theme, context),
  });

  pi.registerTool({
    name: "write_stdin",
    label: "Write Stdin",
    description: `Poll or interact with a live managed ${WINDOWS_NATIVE ? "PowerShell/native Windows" : "shell"} session. Empty chars polls; input is exact and no newline is appended. Active full-screen programs return the latest bounded viewport rather than redraw history.`,
    promptSnippet: `Poll or send exact input to a live managed ${WINDOWS_NATIVE ? "PowerShell/ConPTY" : "shell/PTTY"} session and read its latest bounded terminal output`,
    promptGuidelines: [
      `Use write_stdin only with a live session_id returned by ${PRIMARY_TOOL_NAME}; empty chars polls without input, and non-empty chars is written exactly with no implicit newline.`,
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

  const doctorHandler = async (_args: string, ctx: ExtensionContext): Promise<void> => {
    const report = await runDoctor(await getManager());
    const active = pi.getActiveTools();
    const primary = pi.getAllTools().find((tool) => tool.name === PRIMARY_TOOL_NAME);
    const surface = [
      `${PRIMARY_TOOL_LABEL} override: ${primary?.sourceInfo.source ?? "missing"} (${primary?.sourceInfo.path ?? "unknown"})`,
      `Active tools: ${PRIMARY_TOOL_NAME}=${active.includes(PRIMARY_TOOL_NAME)}, write_stdin=${active.includes("write_stdin")}`,
    ].join("\n");
    ctx.ui.notify(`${formatDoctor(report)}\n${surface}`, report.status === "ok" ? "info" : "warning");
  };
  pi.registerCommand("pwsh-doctor", {
    description: "Report pwsh shell, PTY, process-tree, and artifact diagnostics",
    handler: doctorHandler,
  });
  pi.registerCommand("unified-exec-doctor", {
    description: "Compatibility alias for /pwsh-doctor",
    handler: doctorHandler,
  });
}

export { ProcessManager } from "./runtime/process-manager.js";
export * from "./protocol.js";
