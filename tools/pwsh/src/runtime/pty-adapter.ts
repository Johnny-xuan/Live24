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
  const pty = nodePty.spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    // node-pty stamps `name` over env.TERM, so both values must describe the
    // same capable PTY contract negotiated by buildChildEnvironment().
    name: options.env.TERM ?? "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    encoding: null,
  });
  if (process.platform === "win32" && (!Number.isSafeInteger(pty.pid) || pty.pid <= 0)) {
    const deadline = performance.now() + 2000;
    while ((!Number.isSafeInteger(pty.pid) || pty.pid <= 0) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!Number.isSafeInteger(pty.pid) || pty.pid <= 0) {
      try { pty.kill(); } catch { /* failed spawn */ }
      throw new Error("ConPTY did not publish a valid child PID within 2000ms");
    }
  }
  return pty;
}

export interface PtyProbeOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function probePty(options?: PtyProbeOptions): Promise<{ loaded: boolean; spawnVerified: boolean; error?: string }> {
  try {
    await import("@lydell/node-pty");
    if (!options) return { loaded: true, spawnVerified: false };
    const pty = await spawnPty(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      cols: 80,
      rows: 24,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { pty.kill(); } catch { /* already exited */ }
        reject(new Error(`PTY spawn probe timed out after ${options.timeoutMs ?? 5000}ms`));
      }, options.timeoutMs ?? 5000);
      const disposable = pty.onExit(() => {
        clearTimeout(timeout);
        disposable.dispose();
        try { pty.kill(); } catch { /* already exited */ }
        // The Windows backend disposes its ConPTY output worker after a short
        // drain interval; let that complete so a doctor process can exit.
        setTimeout(resolve, 150);
      });
    });
    return { loaded: true, spawnVerified: true };
  } catch (error) {
    return { loaded: false, spawnVerified: false, error: (error as Error).message };
  }
}
