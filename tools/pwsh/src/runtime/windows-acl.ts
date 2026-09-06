import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WindowsAclVerification {
  secure: boolean;
  sddl?: string;
  error?: string;
}

let cachedCurrentSid: string | undefined;

function systemExecutable(name: string, env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", name);
}

function runSystem(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env,
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

export function currentWindowsSid(env: NodeJS.ProcessEnv = process.env): string {
  if (cachedCurrentSid) return cachedCurrentSid;
  const result = runSystem(systemExecutable("whoami.exe", env), ["/user", "/fo", "csv", "/nh"], env);
  if (result.status !== 0) throw new Error(`unable to resolve current Windows SID (${result.status ?? "spawn failed"})`);
  const sid = result.stdout.match(/S-\d(?:-\d+)+/)?.[0];
  if (!sid) throw new Error("whoami did not return a Windows SID");
  cachedCurrentSid = sid;
  return sid;
}

function readDacl(targetPath: string, env: NodeJS.ProcessEnv): string {
  const savedAcl = path.join(os.tmpdir(), `pwsh-acl-${process.pid}-${randomUUID()}.txt`);
  try {
    const result = runSystem(systemExecutable("icacls.exe", env), [targetPath, "/save", savedAcl, "/c"], env);
    if (result.status !== 0) throw new Error(`unable to export Windows ACL (${result.status ?? "spawn failed"})`);
    const text = readFileSync(savedAcl).toString("utf16le");
    const dacl = text.match(/^D:[^\r\n]+/m)?.[0];
    if (!dacl) throw new Error("Windows ACL export did not contain a DACL");
    return dacl;
  } finally {
    try { unlinkSync(savedAcl); } catch { /* best-effort cleanup */ }
  }
}

function validateDacl(dacl: string, currentSid: string, requireProtected: boolean): WindowsAclVerification {
  if (requireProtected && !dacl.startsWith("D:P")) {
    return { secure: false, sddl: dacl, error: "artifact directory DACL inheritance is not protected" };
  }

  const allowed = new Set(["SY", "BA", currentSid]);
  const principals = new Set<string>();
  const aces = [...dacl.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]!);
  if (aces.length !== allowed.size) return { secure: false, sddl: dacl, error: "artifact DACL contains an unexpected ACE count" };
  for (const ace of aces) {
    const [type, _flags, rights, _objectGuid, _inheritGuid, principal] = ace.split(";");
    if (type !== "A" || rights !== "FA" || !principal || !allowed.has(principal)) {
      return { secure: false, sddl: dacl, error: "artifact DACL grants unexpected access" };
    }
    principals.add(principal);
  }
  if (principals.size !== allowed.size || [...allowed].some((principal) => !principals.has(principal))) {
    return { secure: false, sddl: dacl, error: "artifact DACL is missing a required principal" };
  }
  return { secure: true, sddl: dacl };
}

export function verifyWindowsAcl(
  targetPath: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsAclVerification {
  if (process.platform !== "win32") return { secure: false, error: "Windows ACL verification is unavailable" };
  try {
    const sid = currentWindowsSid(env);
    return validateDacl(readDacl(targetPath, env), sid, false);
  } catch (error) {
    return { secure: false, error: (error as Error).message };
  }
}

export function secureWindowsDirectory(
  targetPath: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsAclVerification {
  if (process.platform !== "win32") return { secure: false, error: "Windows ACL setup is unavailable" };
  try {
    const sid = currentWindowsSid(env);
    const icacls = systemExecutable("icacls.exe", env);
    const grant = runSystem(icacls, [
      targetPath,
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ], env);
    if (grant.status !== 0) return { secure: false, error: `icacls grant failed (${grant.status ?? "spawn failed"})` };
    const protect = runSystem(icacls, [targetPath, "/inheritance:r"], env);
    if (protect.status !== 0) return { secure: false, error: `icacls inheritance protection failed (${protect.status ?? "spawn failed"})` };
    const owner = runSystem(icacls, [targetPath, "/setowner", `*${sid}`, "/c"], env);
    if (owner.status !== 0) return { secure: false, error: `icacls owner assignment failed (${owner.status ?? "spawn failed"})` };
    return validateDacl(readDacl(targetPath, env), sid, true);
  } catch (error) {
    return { secure: false, error: (error as Error).message };
  }
}
