---
name: t3-code
description: "Control T3 Code coding threads with the t3 CLI: list, read, message, approve, stop and watch."
version: 1.0.0
author: deevee
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [T3 Code, coding agents, threads, Codex, Claude, delegation]
prerequisites:
  commands: [t3]
---

# T3 Code

T3 Code runs coding agents (Codex, Claude, Cursor, Hermes…) in threads, one per task, grouped
by project folder. The `t3 thread` commands talk to the running T3 Code app, so the app must be
open. Use them when the user asks about their coding threads, wants work started or continued
in T3, or wants to know when something finishes.

## Commands

```bash
t3 thread list                         # every thread, newest first, with status
t3 thread list --workspace hermes      # only Hermes threads (or --workspace t3)
t3 thread list --json                  # machine-readable
t3 thread show <id>                    # status, pending approvals, last 10 messages
t3 thread show <id> --last 30 --json
t3 thread send <id> "message"          # follow up; a working thread takes it as a steer
t3 thread send <id> "message" --wait   # …and wait for the reply
t3 thread new "task" --project <title|path> --provider codex --wait
t3 thread approve <id>                 # answer the oldest pending approval
t3 thread approve <id> --decision decline
t3 thread stop <id>                    # stop the running turn
t3 thread watch                        # stream status changes of all threads
t3 thread watch <id>                   # follow one thread until it finishes
t3 project add <path>                  # register a folder as a project
```

Ids may be shortened to any unique prefix. Status is one of `working`, `needs-approval`,
`needs-input`, `settled`, `idle` or `error`.

## How to work

- Start with `t3 thread list` to find the thread; read it with `show` before acting on it.
- `new` defaults to the Hermes provider. Pass `--provider codex` or `--provider claudeAgent`
  to hand coding work to those agents, and `--model` to pick a model.
- Prefer `--wait` for short tasks. For long ones, report that the thread started and check
  back with `show` or `watch <id>`.
- Only `approve` after telling the user what the request does (`show` prints it), unless they
  already said to approve it.
- If a command says T3 Code is not running, ask the user to open the app.
