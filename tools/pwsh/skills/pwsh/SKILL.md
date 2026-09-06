---
name: pwsh
description: "Operate managed native shell sessions with pwsh: PowerShell and exact Win32 argv on Windows, Bash on Unix, plus PTY/TUI, write_stdin, timeouts, and safe human attachment."
license: Apache-2.0
compatibility: Requires Pi with the pwsh package extension active.
---

# pwsh

Use the platform-native tool surface:

- **Windows:** `powershell` and `write_stdin`; Windows script strings are PowerShell, not Bash.
- **macOS/Linux:** `bash` and `write_stdin`.

There is no separate `pwsh` model tool and no `exec_command` alias.

## Choose the Smallest Interaction Mode

| Situation | Action |
|---|---|
| Ordinary script that exits on its own | Call the platform shell without `tty` |
| Known native executable with exact arguments | On Windows, prefer `executable` plus `args` |
| Long command that may outlive the initial wait | Call the platform shell; continue only if it returns a live `session_id` |
| Prompt, REPL, editor, or full-screen terminal application | Call with `tty: true`, then use `write_stdin` |
| Password, private value, or direct human judgment is required | Stop model input and ask the user to attach to the session |
| User needs to choose among live PTYs | Ask the user to run the platform attach command without an ID |

Do not allocate a PTY for routine non-interactive commands. PTYs change buffering, colors, signals, and input semantics.

## Windows Rules

Use PowerShell syntax and Windows paths. Do not feed Bash syntax to the `powershell` tool.

- Default script mode resolves PowerShell 7 first and runs without profiles.
- Use `login: true` only when the task really needs profile semantics.
- Call `npm.cmd`, `npx.cmd`, and `pi.cmd` rather than execution-policy-blocked `.ps1` shims.
- Do not add `-ExecutionPolicy Bypass` or change execution policy.
- Prefer exact native mode for a known executable:

```json
{
  "executable": "git.exe",
  "args": ["status", "--short"],
  "workdir": "C:\\work\\repo"
}
```

`args` entries are exact; do not pre-quote them. Direct mode rejects `.cmd`, `.bat`, and `.ps1`, which require an explicit interpreter. For PowerShell scripts that launch native tools, use `exit $LASTEXITCODE` only when the native command's exit code must become the script exit code.

## Continue a Managed Session

A live shell result includes a numeric `session_id`.

- Call `write_stdin` with that exact ID.
- Omit `chars` or send an empty string to poll without input.
- `chars` is exact: no newline is appended. Include `\n` or `\r` only when the application requires it. Windows console applications commonly expect `\r` for Enter.
- For a PTY/ConPTY, send `\u0003` for terminal Ctrl-C.
- For Windows pipes, `\u0003` is deterministic hard process-tree cancellation, not a graceful console Ctrl-C event.
- Treat `yield_time_ms` as time to wait for output, not a hard process timeout.
- Stop polling after exit. Do not reuse an exited or unknown ID.

For full-screen applications, each changed result is the latest bounded terminal viewport, not appended redraw history and not an image. An unchanged screen may produce no duplicate output. Read the current title, selection, status, and visible controls; send the smallest relevant key sequence; then poll again.

Aborting a later empty poll leaves the child alive and recoverable. Initial execution cancellation, hard timeout, pruning, reload, and shutdown own cleanup.

## Handle Large Output

Model-facing output is byte-bounded even for newline-free or continuously redrawn streams. A line-count limiter is not necessarily a byte bound. When a result reports omission, use its protected output artifact only for targeted follow-up reads; do not repeatedly dump the whole artifact back into model context. Pipe artifacts preserve source bytes in observed stdout/stderr order, while Windows ConPTY artifacts preserve transport bytes and may include synthesized VT/wrap output. Treat either artifact as potentially sensitive command output.

Do not infer process completion from a truncated view. Use `status`, `exit_code`, and `session_id`; if the session remains live, poll deliberately or send the next required input rather than starting a duplicate command.

## Hand Control to the User

Never ask a user to paste passwords or other secrets into chat or model tool arguments.

When a live PTY needs private input or direct judgment:

1. Explain why control is needed and give the platform command:
   - Windows: `/powershell-attach <session_id>`
   - macOS/Linux: `/bash-attach <session_id>`
2. Stop sending `write_stdin` input while the user owns the PTY.
3. If a tool call says the session is attached, wait for detach instead of retrying.
4. The user presses Ctrl+Shift+H to open the handoff chooser. Its first/default choice is local return, so Ctrl+Shift+H then Enter closes locally. Down selects queued follow-up or steering. Escape also returns after child exit. A mouse-aware fullscreen host may expose the same `[Close]` path.
5. A handoff notification contains session/status metadata only. Poll with empty `chars` after ownership returns to read bounded output or the current screen.

Windows also keeps `/bash-attach` as a compatibility alias, but new guidance should say `/powershell-attach`.

User input bytes are not independently logged by the package. A child can still echo ordinary input as terminal output; echoed output may later be visible to the Agent or raw artifact. Password prompts normally disable echo, but never assume secrecy if the program displays the value itself.

The attach overlay forwards keyboard input and resize, not mouse/focus protocols. Prefer documented keyboard controls and leave genuinely mouse-dependent input to the human.

## Finish Cleanly

Prefer the application's normal exit command, EOF, or quit key. If it does not respond, send Ctrl-C and poll for final status. Do not leave test or acceptance sessions running. Pi owns cleanup, but verify the observed final state.

## Availability

The platform shell and `write_stdin` are active when the extension is enabled, including with `--no-builtin-tools`. Explicit tool filters still apply. If `write_stdin` is unavailable, do not begin a workflow requiring continued PTY interaction.

For the Windows contract see [Windows Native v1](../../docs/windows-native-v1.md). For screen, privacy, ownership, and handoff behavior see [Terminal Experience v1](../../docs/terminal-experience-v1.md).
