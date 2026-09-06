import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_WRITE_YIELD_TIME_MS,
  MAX_EMPTY_POLL_YIELD_MS,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_POLL_YIELD_MS,
  MIN_YIELD_TIME_MS,
  OUTPUT_MAX_TOKENS,
  WINDOWS_INITIAL_YIELD_FLOOR_MS,
} from "./constants.js";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export const BashParams = Type.Object(
  {
    command: Type.String({ minLength: 1, description: "Shell command to execute." }),
    workdir: Type.Optional(Type.String({ minLength: 1, description: "Absolute workdir or path relative to the Pi session cwd." })),
    shell: Type.Optional(Type.String({ minLength: 1, description: "Recognized shell executable." })),
    login: Type.Optional(Type.Boolean({ default: true, description: "Use login/profile shell semantics when supported." })),
    tty: Type.Optional(Type.Boolean({ default: false, description: "Allocate a PTY and keep stdin writable." })),
    yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, default: DEFAULT_EXEC_YIELD_TIME_MS, description: "Wait before yielding a live process; not a timeout." })),
    timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_TIMEOUT_SECONDS, description: "Hard process timeout in seconds; omitted means no timeout." })),
    max_output_tokens: Type.Optional(Type.Integer({ minimum: 0, maximum: OUTPUT_MAX_TOKENS, default: DEFAULT_MAX_OUTPUT_TOKENS })),
  },
  { additionalProperties: false },
);

export const ExecCommandParams = Type.Object(
  {
    cmd: Type.String({ minLength: 1, description: "Shell command to execute." }),
    workdir: Type.Optional(Type.String({ minLength: 1, description: "Absolute workdir or path relative to the Pi session cwd." })),
    shell: Type.Optional(Type.String({ minLength: 1, description: "Recognized shell executable." })),
    login: Type.Optional(Type.Boolean({ default: true, description: "Use login/profile shell semantics when supported." })),
    tty: Type.Optional(Type.Boolean({ default: false, description: "Allocate a PTY and keep stdin writable." })),
    yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, default: DEFAULT_EXEC_YIELD_TIME_MS, description: "Wait before yielding a live process; not a timeout." })),
    max_output_tokens: Type.Optional(Type.Integer({ minimum: 0, maximum: OUTPUT_MAX_TOKENS, default: DEFAULT_MAX_OUTPUT_TOKENS })),
  },
  { additionalProperties: false },
);

export const WriteStdinParams = Type.Object(
  {
    session_id: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    chars: Type.Optional(Type.String({ default: "", description: "Characters written exactly; empty polls." })),
    yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, default: DEFAULT_WRITE_YIELD_TIME_MS })),
    max_output_tokens: Type.Optional(Type.Integer({ minimum: 0, maximum: OUTPUT_MAX_TOKENS, default: DEFAULT_MAX_OUTPUT_TOKENS })),
  },
  { additionalProperties: false },
);

export type BashInput = Static<typeof BashParams>;
export type ExecCommandInput = Static<typeof ExecCommandParams>;
export type WriteStdinInput = Static<typeof WriteStdinParams>;

export interface OutputArtifactDetails {
  path: string;
  complete: boolean;
  bytes_written: number;
  omitted_bytes: number;
}

export interface UnifiedExecDetails {
  version: 1;
  status: "streaming" | "running" | "exited";
  chunk_id: string;
  wall_time_seconds: number;
  exit_code: number | null;
  session_id: number | null;
  original_token_count: number;
  output_omitted_bytes: number;
  output: string;
  output_artifact?: OutputArtifactDetails;
  output_artifact_error?: "unavailable";
}

export function resolveBashInput(input: BashInput): { execInput: ExecCommandInput; timeoutMs: number | undefined } {
  if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > MAX_TIMEOUT_SECONDS)) {
    throw new Error(`timeout must be greater than 0 and at most ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const { command, timeout, ...options } = input;
  return {
    execInput: { cmd: command, ...options },
    timeoutMs: timeout === undefined ? undefined : timeout * 1000,
  };
}

export function resolveExecInput(input: ExecCommandInput): Required<Omit<ExecCommandInput, "workdir" | "shell">> & Pick<ExecCommandInput, "workdir" | "shell"> {
  return {
    ...input,
    login: input.login ?? true,
    tty: input.tty ?? false,
    yield_time_ms: input.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
    max_output_tokens: input.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

export function resolveWriteInput(input: WriteStdinInput): Required<WriteStdinInput> {
  return {
    ...input,
    chars: input.chars ?? "",
    yield_time_ms: input.yield_time_ms ?? DEFAULT_WRITE_YIELD_TIME_MS,
    max_output_tokens: input.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

export function clampExecYield(ms: number, platform: NodeJS.Platform = process.platform): number {
  const floored = platform === "win32" ? Math.max(ms, WINDOWS_INITIAL_YIELD_FLOOR_MS) : ms;
  return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, floored));
}

export function clampWriteYield(ms: number, empty: boolean): number {
  const floored = Math.max(ms, MIN_YIELD_TIME_MS);
  return empty
    ? Math.min(MAX_EMPTY_POLL_YIELD_MS, Math.max(MIN_EMPTY_POLL_YIELD_MS, floored))
    : Math.min(MAX_YIELD_TIME_MS, floored);
}

export function createChunkId(): string {
  return randomBytes(3).toString("hex");
}

export function approxTokenCount(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}

export function formatDetails(details: UnifiedExecDetails): string {
  const sections = [
    `Chunk ID: ${details.chunk_id}`,
    `Wall time: ${details.wall_time_seconds.toFixed(4)} seconds`,
  ];

  if (details.status === "streaming") sections.push("Process output streaming");
  if (details.status === "running") sections.push(`Process running with session ID ${details.session_id}`);
  if (details.status === "exited") {
    sections.push(details.exit_code === null ? "Process exited with unknown code" : `Process exited with code ${details.exit_code}`);
  }

  sections.push(`Original token count: ${details.original_token_count}`, "Output:", details.output);

  if (details.output_artifact) {
    const artifact = details.output_artifact;
    if (artifact.complete) sections.push(`Complete output saved to: ${artifact.path}`);
    else if (artifact.omitted_bytes === 0) sections.push(`Output artifact is still being written: ${artifact.path}`);
    else sections.push(`Output artifact saved to: ${artifact.path} (${artifact.omitted_bytes} raw bytes omitted by artifact limit)`);
  } else if (details.output_artifact_error) {
    sections.push("Output artifact unavailable");
  }

  return sections.join("\n");
}
