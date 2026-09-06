import { stat } from "node:fs/promises";
import { ARTIFACT_MANAGER_MAX_BYTES, ARTIFACT_PROCESS_MAX_BYTES } from "./constants.js";
import { ArtifactStore } from "./runtime/artifact-store.js";
import type { ProcessManager } from "./runtime/process-manager.js";
import { probePty } from "./runtime/pty-adapter.js";
import { normalizeShellIdentity, resolveShell } from "./runtime/shell.js";

export interface DoctorReport {
  status: "ok" | "degraded";
  issues: Array<"pty_unavailable" | "artifacts_unavailable" | "unsafe_permissions" | "unsafe_acl">;
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  shell: { identity: string; executable: string; fallback: boolean };
  pty: { loaded: boolean; error?: string };
  process_tree_strategy: string;
  ctrl_c_strategy: string;
  artifacts: {
    enabled: boolean;
    root?: string;
    directory_mode?: string;
    process_limit_bytes: number;
    manager_limit_bytes: number;
    current_manager_bytes: number;
  };
}

export function classifyDoctor(input: {
  platform: NodeJS.Platform;
  ptyLoaded: boolean;
  artifactsEnabled: boolean;
  directoryMode?: string;
  artifactSecurityIssue?: "unsafe_permissions" | "unsafe_acl";
}): Pick<DoctorReport, "status" | "issues"> {
  const issues: DoctorReport["issues"] = [];
  if (!input.ptyLoaded) issues.push("pty_unavailable");
  if (input.artifactSecurityIssue) issues.push(input.artifactSecurityIssue);
  else if (!input.artifactsEnabled) issues.push("artifacts_unavailable");
  else if (input.platform !== "win32" && input.directoryMode !== "0700") issues.push("unsafe_permissions");
  return { status: issues.length === 0 ? "ok" : "degraded", issues };
}

export async function runDoctor(manager?: ProcessManager): Promise<DoctorReport> {
  const shell = resolveShell("true", { login: true });
  const pty = await probePty();
  const temporaryArtifacts = manager ? undefined : await ArtifactStore.create();
  const artifacts = manager?.artifacts ?? temporaryArtifacts!;
  let directoryMode: string | undefined;
  const root = artifacts.root;
  if (root && process.platform !== "win32") {
    const info = await stat(root);
    directoryMode = (info.mode & 0o777).toString(8).padStart(4, "0");
  }

  const artifactsEnabled = artifacts.enabled;
  const classification = classifyDoctor({
    platform: process.platform,
    ptyLoaded: pty.loaded,
    artifactsEnabled,
    directoryMode,
    artifactSecurityIssue: process.platform === "win32" && !artifactsEnabled ? "unsafe_acl" : undefined,
  });
  const report: DoctorReport = {
    ...classification,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    shell: { identity: normalizeShellIdentity(shell.executable), executable: shell.executable, fallback: shell.fallback },
    pty,
    process_tree_strategy: process.platform === "win32" ? "taskkill /T /F" : "detached POSIX process group TERM→KILL",
    ctrl_c_strategy: process.platform === "win32" ? "PTY byte; pipes SIGINT best-effort" : "PTY byte; pipes process-group SIGINT",
    artifacts: {
      enabled: artifactsEnabled,
      ...(manager && root ? { root } : {}),
      ...(directoryMode ? { directory_mode: directoryMode } : {}),
      process_limit_bytes: artifacts.processLimit ?? ARTIFACT_PROCESS_MAX_BYTES,
      manager_limit_bytes: artifacts.managerLimit ?? ARTIFACT_MANAGER_MAX_BYTES,
      current_manager_bytes: artifacts.usedBytes ?? 0,
    },
  };
  if (temporaryArtifacts) await temporaryArtifacts.shutdown();
  return report;
}

export function formatDoctor(report: DoctorReport): string {
  return [
    `Unified Exec doctor: ${report.status}${report.issues.length ? ` (${report.issues.join(", ")})` : ""}`,
    `Platform: ${report.platform}/${report.arch} ${report.node}`,
    `Shell: ${report.shell.executable} (${report.shell.identity}${report.shell.fallback ? ", fallback" : ""})`,
    `PTY: ${report.pty.loaded ? "loaded" : `unavailable (${report.pty.error ?? "unknown error"})`}`,
    `Process tree: ${report.process_tree_strategy}`,
    `Ctrl-C: ${report.ctrl_c_strategy}`,
    `Artifacts: ${report.artifacts.enabled ? "enabled" : "disabled"}${report.artifacts.root ? ` at ${report.artifacts.root}` : ""}${report.artifacts.directory_mode ? ` mode ${report.artifacts.directory_mode}` : ""}`,
    `Artifact limits: ${report.artifacts.process_limit_bytes} per process / ${report.artifacts.manager_limit_bytes} manager (${report.artifacts.current_manager_bytes} used)`,
  ].join("\n");
}
