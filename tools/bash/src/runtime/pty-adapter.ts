import type { IPty } from "@lydell/node-pty";
import { normalizeTerminalSize } from "./terminal-size.js";

export interface PtySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export async function spawnPty(
  executable: string,
  args: string[],
  options: PtySpawnOptions,
): Promise<IPty> {
  const nodePty = await import("@lydell/node-pty");
  const size = normalizeTerminalSize(options);
  return nodePty.spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    // node-pty stamps `name` over env.TERM, so both values must describe the
    // same capable PTY contract negotiated by buildChildEnvironment().
    name: options.env.TERM ?? "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    encoding: null,
  });
}

export async function probePty(): Promise<{ loaded: boolean; error?: string }> {
  try {
    await import("@lydell/node-pty");
    return { loaded: true };
  } catch (error) {
    return { loaded: false, error: (error as Error).message };
  }
}
