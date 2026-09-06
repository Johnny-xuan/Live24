# Provenance

pwsh's Unified Exec engine is an independent TypeScript adaptation informed by the Apache-2.0 OpenAI Codex process layer.

## Reference version

- Repository: `openai/codex`
- Tag: `rust-v0.147.0`
- Commit: `be6e8eac029b183056b7e4402879f15d2c85f61b`
- License: Apache-2.0

## Source mapping

| Adapted behavior | Codex source path |
|---|---|
| tool inputs/defaults | `codex-rs/core/src/tools/handlers/unified_exec.rs`, `shell_spec.rs` |
| command/workdir/shell | `codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs`, `core/src/shell.rs` |
| session manager/yield/poll/prune | `codex-rs/core/src/unified_exec/process_manager.rs` |
| process/stdin/signal state | `codex-rs/core/src/unified_exec/process.rs` |
| head/tail retention | `codex-rs/core/src/unified_exec/head_tail_buffer.rs` |
| streaming | `codex-rs/core/src/unified_exec/async_watcher.rs` |
| token truncation | `codex-rs/utils/output-truncation/src/lib.rs`, `codex-rs/utils/string/src/truncate.rs` |
| result formatting | `codex-rs/core/src/tools/context.rs` |

PTY allocation is delegated to the MIT-licensed `@lydell/node-pty` platform packages. The pinned MIT-licensed `@xterm/headless@6.0.0` package is the sole PTY cell/cursor/screen authority behind a zero-scrollback, pressure- and generation-aware adapter. `src/output/xterm-unicode-v6.ts` reproduces that pinned release's MIT-licensed `src/common/input/UnicodeV6.ts` zero-width ranges so the adapter can bound every code point Xterm would append to an existing cell. Package-owned layers retain the independent raw artifact and stable transcript; neither dependency owns Pi sessions, artifacts, timeouts, or process cleanup.

The 0.1.0 bounded-output upgrade also used the audited local `pi-super-bash` handoff snapshot as an implementation reference. Its 76-file `SHA256SUMS.json` manifest was verified before comparison; the merge retained this package's Windows-native execution/security layers rather than replacing the package wholesale. The root license, this provenance record, and NOTICE attribution remain part of the package.

No proprietary Codex plugin implementation is included. Codex sandbox, remote-environment, network-proxy, approval, hook, and Code Mode layers are not copied or claimed.

## Modifications

The TypeScript files are new and prominently identify adapted algorithms where applicable. Pi-specific changes include `AbortSignal`, `onUpdate`, session-shutdown cleanup, bounded raw artifacts, fixed-slab UTF-8/SGR-safe retention, per-stream decoding, bounded ECMA-48 framing, source/sink backpressure, initial-interaction prune protection, Pi session metadata, host-sized/resizable PTYs, completed-generation and lazy Xterm projection, geometry-scaled zero-width cell limits, containing-background-safe ANSI rendering, and model/TUI presentation.

The Windows-native layer is package-owned TypeScript: PowerShell-first executable resolution, exact native argv dispatch, UTF-8 setup, ConPTY lifecycle, direct `taskkill.exe` tree cleanup, and fail-closed artifact DACL hardening/audit through Windows `whoami.exe` and `icacls.exe`. It does not copy a third-party PowerShell adapter or ship an additional Job Object binary.
