import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

export type ShellIdentity = "sh" | "bash" | "zsh" | "powershell" | "pwsh" | "cmd";
const SUPPORTED = new Set<ShellIdentity>(["sh", "bash", "zsh", "powershell", "pwsh", "cmd"]);

export interface ResolvedCommand {
  executable: string;
  identity: ShellIdentity | "native";
  argv: string[];
  fallback: boolean;
}

export interface ResolvedShell extends ResolvedCommand {
  identity: ShellIdentity;
}

export interface ResolveShellOptions {
  shell?: string;
  login: boolean;
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  preferPowerShell?: boolean;
  nativePowerShell?: boolean;
}

const POWERSHELL_UTF8_PREAMBLE = [
  "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
  "try { [Console]::InputEncoding = $utf8NoBom } catch {}",
  "try { [Console]::OutputEncoding = $utf8NoBom } catch {}",
  "$global:OutputEncoding = $utf8NoBom",
].join("; ");

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function stripWrappingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function executableSuffixes(executable: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  if (path.win32.extname(executable)) return [""];
  const pathExt = envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return ["", ...pathExt.split(";").map((suffix) => suffix.trim()).filter(Boolean)];
}

export function resolveExecutablePath(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): string | undefined {
  const requested = stripWrappingQuotes(executable.trim());
  if (!requested) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const mode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  const suffixes = executableSuffixes(requested, env, platform);
  const probe = (candidate: string): string | undefined => {
    try {
      accessSync(candidate, mode);
      return pathApi.normalize(candidate);
    } catch {
      return undefined;
    }
  };

  const hasSeparator = requested.includes("/") || requested.includes("\\");
  if (hasSeparator || pathApi.isAbsolute(requested)) {
    const base = pathApi.isAbsolute(requested) ? requested : pathApi.resolve(cwd, requested);
    for (const suffix of suffixes) {
      const found = probe(base + suffix);
      if (found) return found;
    }
    return undefined;
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const pathValue = envValue(env, "PATH") ?? "";
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = stripWrappingQuotes(rawDirectory.trim());
    if (!directory) continue;
    for (const suffix of suffixes) {
      const found = probe(pathApi.join(directory, requested + suffix));
      if (found) return found;
    }
  }
  return undefined;
}

export function resolveNativeCommand(
  executable: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedCommand {
  const resolved = resolveExecutablePath(executable, env, platform);
  if (!resolved) throw new Error(`native executable not found: ${executable}`);
  if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(resolved)) {
    throw new Error(`native argv mode does not execute interpreter-dependent scripts: ${executable}; use PowerShell script mode instead`);
  }
  return { executable: resolved, identity: "native", argv: [resolved, ...args], fallback: false };
}

export function normalizeShellIdentity(executable: string, platform: NodeJS.Platform = process.platform): string {
  const basename = platform === "win32" ? path.win32.basename(executable) : path.basename(executable);
  return basename.toLowerCase().replace(/\.exe$/i, "");
}

function isSupported(executable: string, platform: NodeJS.Platform): boolean {
  return SUPPORTED.has(normalizeShellIdentity(executable, platform) as ShellIdentity);
}

export function resolvePreferredPowerShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { executable: string; identity: "pwsh" | "powershell" | "cmd"; fallback: boolean } {
  if (platform !== "win32") throw new Error("PowerShell preference is only available on Windows");
  const systemRoot = envValue(env, "SystemRoot") ?? envValue(env, "WINDIR");
  const candidates = [
    { requested: "pwsh.exe", fallback: false },
    ...(systemRoot ? [{ requested: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), fallback: true }] : []),
    { requested: "powershell.exe", fallback: true },
    ...(envValue(env, "COMSPEC") ? [{ requested: envValue(env, "COMSPEC")!, fallback: true }] : []),
    { requested: "cmd.exe", fallback: true },
  ];

  for (const candidate of candidates) {
    if (!isSupported(candidate.requested, platform)) continue;
    const executable = resolveExecutablePath(candidate.requested, env, platform);
    if (!executable) continue;
    return {
      executable,
      identity: normalizeShellIdentity(executable, platform) as "pwsh" | "powershell" | "cmd",
      fallback: candidate.fallback,
    };
  }
  throw new Error("No PowerShell or Windows command shell executable was found");
}

export function resolveShell(cmd: string, options: ResolveShellOptions): ResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const explicit = options.shell;
  let executable: string;
  let argvExecutable: string;
  let fallback = false;

  if (explicit) {
    const identity = normalizeShellIdentity(explicit, platform) as ShellIdentity;
    if (!SUPPORTED.has(identity)) throw new Error(`unsupported shell: ${explicit}`);
    const resolved = platform === process.platform ? resolveExecutablePath(explicit, env, platform) : explicit;
    if (!resolved) throw new Error(`shell executable not found: ${explicit}`);
    executable = resolved;
    argvExecutable = explicit;
  } else if (platform === "win32" && options.preferPowerShell) {
    const preferred = resolvePreferredPowerShell(env, platform);
    executable = preferred.executable;
    argvExecutable = executable;
    fallback = preferred.fallback;
  } else {
    const fallbackExecutable = platform === "win32" ? "cmd.exe" : "/bin/sh";
    const environmentShell = platform === "win32" ? envValue(env, "COMSPEC") : envValue(env, "SHELL");
    let resolvedEnvironment: string | undefined;
    if (environmentShell && isSupported(environmentShell, platform)) {
      if (platform === process.platform) {
        resolvedEnvironment = resolveExecutablePath(environmentShell, env, platform);
      } else {
        try {
          accessSync(environmentShell, fsConstants.X_OK);
          resolvedEnvironment = environmentShell;
        } catch {
          resolvedEnvironment = undefined;
        }
      }
    }
    if (resolvedEnvironment) {
      executable = resolvedEnvironment;
      argvExecutable = environmentShell!;
    } else {
      executable = platform === process.platform
        ? (resolveExecutablePath(fallbackExecutable, env, platform) ?? fallbackExecutable)
        : fallbackExecutable;
      argvExecutable = fallbackExecutable;
      fallback = true;
    }
  }

  const identity = normalizeShellIdentity(executable, platform) as ShellIdentity;
  if (!SUPPORTED.has(identity)) throw new Error(`unsupported shell: ${executable}`);

  let args: string[];
  if (identity === "sh" || identity === "bash" || identity === "zsh") {
    args = [options.login ? "-lc" : "-c", cmd];
  } else if (identity === "powershell" || identity === "pwsh") {
    if (options.nativePowerShell) {
      args = ["-NoLogo"];
      if (!options.login) args.push("-NoProfile");
      if (!options.tty) args.push("-NonInteractive");
      args.push("-Command", `${POWERSHELL_UTF8_PREAMBLE}; ${cmd}`);
    } else {
      args = options.login ? ["-Command", cmd] : ["-NoProfile", "-Command", cmd];
    }
  } else {
    args = ["/c", cmd];
  }

  return { executable, identity, argv: [argvExecutable, ...args], fallback };
}
