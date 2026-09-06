---
name: bash
description: Operate managed Bash sessions in Pi. Use for one-shot commands, long-running processes, interactive PTYs, full-screen terminal applications, repeated write_stdin interaction, or safe human takeover through /bash-attach.
license: Apache-2.0
compatibility: Requires Pi with the bash package extension active.
---

# Bash

Use Pi's standard `bash` name for both ordinary commands and managed terminal sessions. The package replaces the built-in `bash` slot. Its companion `write_stdin` tool controls live sessions returned by `bash`.

## Choose the Smallest Interaction Mode

| Situation | Action |
|---|---|
| Ordinary command that exits on its own | Call `bash` without `tty` |
| Long command that may outlive the initial wait | Call `bash`; continue only if it returns a live `session_id` |
| Prompt, REPL, editor, or full-screen terminal application | Call `bash` with `tty: true`, then use `write_stdin` |
| Password, private value, or direct human judgment is required | Stop model input and ask the user to run `/bash-attach <session_id>` |
| User needs to choose among live PTYs | Ask the user to run `/bash-attach` and use the picker |

Do not allocate a PTY for routine non-interactive commands. PTYs change buffering, colors, signal behavior, and input semantics.

## Continue a Managed Session

A live `bash` result includes a numeric `session_id`.

- Call `write_stdin` with that exact ID.
- Omit `chars` or send an empty string to poll without input.
- `chars` is exact: no newline is appended. Include `\n` or `\r` only when the program needs it.
- Send `\u0003` for a terminal Ctrl-C when interruption is required.
- Treat `yield_time_ms` as the time to wait for output, not as a hard process timeout.
- Stop polling once the session reports that it exited. Do not reuse an exited or unknown ID.

For active full-screen applications, each changed result is the latest bounded terminal viewport, not appended redraw history and not an image. An unchanged screen may produce no duplicate output. Read the current title, selection, status, and visible controls, send the smallest relevant key sequence, then poll again.

## Hand Control to the User

Never ask a user to paste passwords or other secrets into chat or model tool arguments.

When a live PTY needs private or direct human interaction:

1. Tell the user why control is needed and give `/bash-attach <session_id>`.
2. Stop sending `write_stdin` input while the user owns the PTY.
3. If a tool call reports that the session is attached by the user, wait for detach instead of retrying.
4. The user presses Ctrl+Shift+H to open the handoff chooser. Enter closes locally; Down selects queued follow-up or steering handoff. After the child exits, Escape also returns locally. On a mouse-aware fullscreen host, `[Close]` follows the same local-return path.
5. A handoff notification contains session/status metadata only. Call `write_stdin` with empty `chars` to read the resulting bounded output or current screen.

User input bytes are not independently logged by this package. A child can still echo ordinary input as terminal output; that echoed output may later be visible to the Agent. Password-oriented prompts normally disable echo, but never assume secrecy if the target program displays the value itself.

The v1 attach overlay forwards keyboard input and resize, not mouse/focus protocols. Prefer documented keyboard controls; leave genuinely mouse-dependent interaction to an appropriate external human terminal workflow.

## Finish Cleanly

Prefer the application's normal exit command (`exit`, EOF, quit key, or equivalent). If it does not respond, send Ctrl-C and poll for the final exit status. Do not leave test or acceptance sessions running. Pi owns cleanup on timeout, cancellation, reload, and shutdown, but the Agent should still verify the observed final state.

## Availability

`bash` and `write_stdin` are active by default when the package is enabled, including when Pi starts with `--no-builtin-tools`. Explicit tool filters still apply: `--tools bash` excludes `write_stdin`. If `write_stdin` is unavailable, do not start a workflow that depends on continued PTY interaction; ask for the companion tool to be enabled.
