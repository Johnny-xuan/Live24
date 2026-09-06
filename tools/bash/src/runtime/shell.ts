import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

export type ShellIdentity = "sh" | "bash" | "zsh" | "powershell" | "pwsh" | "cmd";
const SUPPORTED = new Set<ShellIdentity>(["sh", "bash", "zsh", "powershell", "pwsh", "cmd"]);

export interface ResolvedShell {
  executable: string;
  identity: ShellIdentity;
  argv: string[];
  fallback: boolean;
}

export function normalizeShellIdentity(executable: string, platform: NodeJS.Platform = process.platform): string {
  const basename = platform === "win32" ? path.win32.basename(executable) : path.basename(executable);
  return basename.toLowerCase().replace(/\.exe$/i, "");
}

function isSupported(executable: string, platform: NodeJS.Platform): executable is string {
  return SUPPORTED.has(normalizeShellIdentity(executable, platform) as ShellIdentity);
}

function isResolvable(executable: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const mode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  const hasSeparator = executable.includes("/") || executable.includes("\\");
  if (hasSeparator || path.isAbsolute(executable)) {
    try {
      accessSync(executable, mode);
      return true;
    } catch {
      return false;
    }
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const suffixes = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return pathValue.split(path.delimiter).some((directory) => suffixes.some((suffix) => {
    try {
      accessSync(path.join(directory, executable + suffix), mode);
      return true;
    } catch {
      return false;
    }
  }));
}

export function resolveShell(
  cmd: string,
  options: { shell?: string; login: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): ResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fallbackExecutable = platform === "win32" ? "cmd.exe" : "/bin/sh";
  const environmentShell = platform === "win32" ? env.COMSPEC : env.SHELL;
  let executable = options.shell;
  let fallback = false;

  if (!executable) {
    if (environmentShell && isSupported(environmentShell, platform) && isResolvable(environmentShell, env, platform)) {
      executable = environmentShell;
    } else {
      executable = fallbackExecutable;
      fallback = true;
    }
  }

  const identity = normalizeShellIdentity(executable, platform) as ShellIdentity;
  if (!SUPPORTED.has(identity)) throw new Error(`unsupported shell: ${executable}`);

  let args: string[];
  if (identity === "sh" || identity === "bash" || identity === "zsh") {
    args = [options.login ? "-lc" : "-c", cmd];
  } else if (identity === "powershell" || identity === "pwsh") {
    args = options.login ? ["-Command", cmd] : ["-NoProfile", "-Command", cmd];
  } else {
    args = ["/c", cmd];
  }

  return { executable, identity, argv: [executable, ...args], fallback };
}
