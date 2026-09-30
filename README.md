# pi-bg-bash

Replaces the model's `bash` tool with Pi's own `bash` plus a `background`
flag. A call with `background: true` starts the command detached, returns a
task id at once, and reports the result when the command exits.

- **Wrapper:** `sh` spawned `detached`, stdout and stderr on the log's file
  descriptor, the handle `unref()`ed. It runs the command, passed as an
  argument, in Pi's own shell (`getShellConfig`, so bash-only syntax works) with
  Pi's shell environment (`getShellEnv`; where a Pi version lacks an export it
  falls back to `sh -c` and `process.env` plus `<agent dir>/bin` on PATH), plus
  the session variables Pi's bash tool sets, taken from the context:
  `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`,
  `PI_REASONING_LEVEL` (each left out when the context has no value; inherited
  ones are cleared first, as Pi does). When
  the command exits the wrapper appends `__PI_BG_EXIT__:<nonce>:<code>`. The
  nonce is random per task and passed as an argument, so output that looks like
  a marker is not one. The marker is found wherever it sits, since a
  backgrounded grandchild may write after it, and is never shown as output.
- **Spawn failures:** a missing working directory is refused with "Working
  directory does not exist"; a failed spawn rejects, and no log is left.
- **Logs:** `$XDG_STATE_HOME/pi-bg/<session-id>/<id>.log` (default
  `~/.local/state`), directory `0o700`, file `0o600`, created exclusively. Ids
  restart at `bg-1` per Pi process, so a resumed session skips any id whose
  `.log` or `.log.gz` already exists.
- **Not honoured:** Pi's `shellPath` and `shellCommandPrefix` settings. An
  extension cannot read them, so neither background nor foreground commands
  use them.
- **Registry:** on `globalThis` under `Symbol.for("pi-bg-bash.registry")`, with
  one 2 s poller. A task ends when its marker appears, or when its pid is gone
  with no marker (exit unknown). A log that is missing also means exit unknown.
  Any other read error is retried on later ticks; once the pid is dead and five
  reads in a row have failed, the exit is unknown too. A single failure never
  hides a real exit. One task's failure, a stale footer context or a throwing
  `sendMessage` never stops the poller; a message that failed to send is
  retried on a later tick. A task is registered only after its spawn resolves.
- **Completion message:** one `pi.sendMessage` custom message per task,
  `deliverAs: "followUp"`, `triggerTurn: true`, with the id, command, exit
  state (`exited (code N)`, `killed (timed out)`, `killed (killed by user)`, or
  `exit unknown`, the same wording as `bash_tasks`), runtime and the last ~20
  lines of output.
- **Footer:** `ctx.ui.setStatus("bg", "bg: N")` while N tasks run.
- A call without `background` runs through Pi's default bash operations.

## `bash_output`

`bash_output({ id, latest?, filter? })` reads a task's log, running or
finished.

- Returns the oldest unread output from the task's read position, capped like
  Pi's `truncateHead` (`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`), counted in raw bytes. When more
  is left it says "More remaining" and how many bytes; call again for the next
  page. The position moves only past what was returned, so calls never overlap.
- A running task's half-written last line waits for its newline.
- `latest: true` returns the newest *unread* output (`truncateTail` limits; the
  window never starts before the read position) and moves the position to the
  end, noting any unread bytes it skipped. With nothing unread it returns
  "(no new output)".
- The position counts raw log bytes, so invalid UTF-8 does not lose lines.
- `filter` is a regex applied to the lines returned; the position still moves
  past every line read, matching or not.
- The exit marker is never output. The first line reports the task, worded as
  in `bash_tasks`: `running`, `exited (code N)`, `killed (reason)` or `exit unknown`.
- An unknown id, or an invalid filter, throws, which Pi reports as an error
  result.
- The completion message's tail is separate and never moves the position.

## Killing, listing and deadlines

- **Group kill** (`kill.ts`): SIGTERM the task's process group (the wrapper
  leads it, so the command and everything it started), wait about 3 s, then
  SIGKILL the group if anything is left. It signals only pids this registry
  launched, and refuses a pid of 1 or below. A group that is already gone is not
  an error. After SIGKILL it waits 1 s; a group still there then is reported as
  such (`bash_kill` says the group is still running), never as gone. The grace
  period is 3 s; `PI_BG_BASH_GRACE_MS` overrides it, for the tests.
- **The process port** (`port.ts`): the extension's only contact with real
  processes, with four operations: launch a task, signal a group, check whether a
  group is alive, check whether a pid is. It owns the errno mapping: ESRCH and
  EPERM both mean "gone". EPERM is what macOS answers for a group of only
  zombies, and for a pid that now belongs to someone else. The escalation above
  runs on timers, so tests can drive it. Tests replace the port through the test
  harness only; there is no option or setting for it.
- **How a kill is recorded:** a killed task has state `killed` and a `reason`
  (`killed by agent`, `killed by user`, `timed out`) kept in the registry, and
  reported as `killed (reason)` by `bash_tasks`, `bash_output` and the completion
  message. The group kill also takes the wrapper down, so no marker is written
  and the log's marker stays digits-only; later kinds of kill (session end, Pi
  gone, log limit) add reasons the same way.
- `bash_tasks()`: one line per task, `id | state | runtime | command`. State is
  `running`, `exited (code N)`, `killed (reason)` or `exit unknown`. Says "No
  background tasks." when there are none.
- `bash_kill({ id })`: kills as above, sets `notified` so no completion message
  follows, and reports the final state. An unknown id throws; a task that
  already ended (even if the poller had not yet noticed) is reported as
  already finished; a "running" task whose group is already gone is settled as
  exit unknown. Two kills of one task share the same kill.
- **Deadline:** `bash` with `background: true` and an explicit `timeout`
  (seconds) records `startedAt + timeout` as the task's deadline. The poller,
  on the first tick after it, runs the group kill and sends the completion
  message saying `timed out`. Without a `timeout` a background task has none.
- `/bg`: with a UI, `ctx.ui.select` over every task (same line as
  `bash_tasks`); picking a running task kills it and sends the completion
  message saying `killed by user`, picking a finished one does nothing. Without
  a UI it prints the list with `ctx.ui.notify` and kills nothing.

Uses no `pi.events` hook.

## Install

```bash
pi install <path to this directory>
```

The package has no dependencies and no build step. The `pi` manifest loads only
`./index.ts`; the tests under `test/` are not loaded by Pi. Not installed in any
route yet.

## Requirements

- Pi, with `pi.registerTool`, `pi.sendMessage` and `ctx.ui.setStatus`.
- `@earendil-works/pi-coding-agent` for `createBashToolDefinition`,
  `truncateTail`, `getShellConfig` and the limits, declared as a peer
  dependency and supplied by Pi.
- `typebox` for the tools' parameter schema, a host-provided peer dependency.
- A POSIX `sh`; the command itself runs in Pi's shell (bash when present).

## Tests

`make test-pi-bg` runs two tiers. Fake time and real processes never meet in one
test file, and `--test-timeout` makes a call that never settles fail the run
instead of hanging it.

- **Behaviour tests** (`background`, `kill`, `output`, `poller`): the extension
  runs over a scripted fake process table behind the process port, on
  `node:test` mock timers that start at the real now. The test decides when a
  task writes, exits (writing the marker with its nonce), traps SIGTERM, leaves a
  child or a zombie group, dies without a marker or survives SIGKILL. Logs are
  real files under a temporary `XDG_STATE_HOME`. `clock.settle(call)` ticks the
  clock until a call settles; no test awaits a timer-driven call without it.
- **Contract tests** (`contract`): the real port with short real `sh` commands
  on real time and no mock timers: quoting and heredocs, Pi's shell and
  environment, the marker and nonce (grandchild, spoofed marker, marker across
  a read window), the group kill (child, `trap '' TERM`), the errno mapping
  (including the macOS zombie-only group, macOS only), spawn failures and
  exclusive log creation. `PI_BG_BASH_GRACE_MS` shortens the kill's grace period.
