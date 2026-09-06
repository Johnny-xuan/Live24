import { spawn } from "node:child_process";
import path from "node:path";
import { WINDOWS_TASKKILL_TIMEOUT_MS } from "../constants.js";

function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (processExists(pid)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

export async function terminateWindowsProcessTree(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  taskkillTimeoutMs = WINDOWS_TASKKILL_TIMEOUT_MS,
  launchTaskkill: typeof spawn = spawn,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  const taskkillSucceeded = await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(succeeded);
    };
    try {
      const killer = launchTaskkill(taskkillPath(env), ["/PID", String(pid), "/T", "/F"], {
        env,
        windowsHide: true,
        stdio: "ignore",
      });
      timer = setTimeout(() => {
        try { killer.kill("SIGKILL"); } catch { /* continue to root fallback */ }
        done(false);
      }, Math.max(1, taskkillTimeoutMs));
      killer.once("close", (code) => done(code === 0));
      killer.once("error", () => done(false));
    } catch {
      done(false);
    }
  });
  if (taskkillSucceeded && await waitForProcessExit(pid, 1000)) return true;
  try {
    process.kill(pid);
  } catch {
    // The process exited between liveness verification and the fallback.
  }
  await waitForProcessExit(pid, 500);
  // A root-only fallback cannot prove that taskkill terminated descendants.
  // Return failure even when the root is gone so callers never overclaim tree cleanup.
  return false;
}
