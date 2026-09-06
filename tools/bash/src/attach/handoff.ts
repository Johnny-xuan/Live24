export type AttachHandoffMode = "none" | "queued" | "steering";

export interface AttachHandoffStatus {
  sessionId: number;
  status: "running" | "exited";
  exitCode?: number | null;
}

export interface AttachHandoffMessage {
  customType: "pi-bash-attach";
  content: string;
  display: true;
  details: AttachHandoffStatus;
}

export interface AttachHandoffDelivery {
  deliverAs: "followUp" | "steer";
  triggerTurn: true;
}

export function resolveHandoffDelivery(mode: AttachHandoffMode): AttachHandoffDelivery | undefined {
  if (mode === "queued") return { deliverAs: "followUp", triggerTurn: true };
  if (mode === "steering") return { deliverAs: "steer", triggerTurn: true };
  return undefined;
}

export function buildAttachHandoff(status: AttachHandoffStatus): AttachHandoffMessage {
  const state = status.status === "running"
    ? `The process is still running. You may continue using write_stdin with session ID ${status.sessionId}.`
    : status.exitCode === null || status.exitCode === undefined
      ? "The process exited with an unknown code."
      : `The process exited with code ${status.exitCode}.`;
  return {
    customType: "pi-bash-attach",
    content: [
      `The user detached from Bash session ${status.sessionId}.`,
      "Exclusive user ownership has ended.",
      state,
    ].join("\n"),
    display: true,
    details: status,
  };
}
