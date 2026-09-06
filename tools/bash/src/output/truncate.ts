// Source-informed adaptation of OpenAI Codex rust-v0.147.0
// codex-rs/utils/string/src/truncate.rs and utils/output-truncation/src/lib.rs.
const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

export function lineCountLikeRust(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return text.endsWith("\n") ? count : count + 1;
}
