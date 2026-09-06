export interface PiSessionEnvironment {
  sessionId?: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
}

const PI_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;

export interface ChildEnvironmentOptions {
  tty?: boolean;
  platform?: NodeJS.Platform;
}

function capableTerminalName(term: string | undefined): string {
  const normalized = term?.trim();
  return normalized && normalized !== "dumb" && normalized !== "unknown" ? normalized : "xterm-256color";
}

export function buildChildEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  metadata: PiSessionEnvironment = {},
  options: ChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const piKeys = new Set<string>(PI_KEYS);
  for (const key of Object.keys(env)) {
    if (piKeys.has(key.toUpperCase())) delete env[key];
  }

  if (metadata.sessionId) env.PI_SESSION_ID = metadata.sessionId;
  if (metadata.sessionFile) env.PI_SESSION_FILE = metadata.sessionFile;
  if (metadata.provider) env.PI_PROVIDER = metadata.provider;
  if (metadata.model) env.PI_MODEL = metadata.model;
  if (metadata.reasoningLevel) env.PI_REASONING_LEVEL = metadata.reasoningLevel;

  if (options.tty) {
    // A writable PTY is a real terminal contract. Preserve an inherited capable
    // identity, but do not let a headless/dumb parent disable alternate screens,
    // cursor addressing, or resize-aware full-screen applications.
    env.TERM = capableTerminalName(inherited.TERM);
  } else {
    // Pipes remain intentionally noninteractive and low-noise.
    env.NO_COLOR = "1";
    env.TERM = "dumb";
    env.COLORTERM = "";
  }
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  if ((options.platform ?? process.platform) === "win32") {
    env.PYTHONUTF8 = "1";
    env.PYTHONIOENCODING = "utf-8";
  }
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  env.GH_PAGER = "cat";
  return env;
}
