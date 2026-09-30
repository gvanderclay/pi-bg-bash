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
  ones are cleared first, as Pi does). When the command exits the wrapper appends
  `__PI_BG_EXIT__:<nonce>:<code>`. The nonce is random per task and passed as an
  argument, so output that looks like a marker is not one. The marker is found
  wherever it sits, since a backgrounded grandchild may write after it, and is
  never shown as output. The wrapper's own stderr is silenced (the command's still
  reaches the log), so a shell job notice like `Killed: 9` for a command that
  killed itself is not output. A separate `sh` watcher, its own detached process
  outside the task's group, is given Pi's pid and the task's group; it exits once
  the group is empty, and when Pi dies first it appends `__PI_BG_GONE__:<nonce>`
  and SIGKILLs whatever is left. A watcher that fails to start leaves the task
  running without a crash watch (fail open).
- **Spawn failures:** a missing working directory is refused with "Working
  directory does not exist"; a failed spawn rejects, and no log is left.
- **Logs:** `$XDG_STATE_HOME/pi-bg/<session-id>/<id>.log` (default
  `~/.local/state`), directory `0o700`, file `0o600`, created exclusively. The
  session directory carries an `owner.pid` marker naming the Pi process that
  owns it, so another Pi's cleanup never deletes a live task's log. A pid the
  OS has reused can keep a dead owner's directory out of reach for one session
  start, but the next start re-checks and removes it once the pid is gone. Ids restart
  at `bg-1` per Pi process, so a resumed session skips any id whose `.log` or
  `.log.gz` already exists. Once a task's completion message has been sent, the
  log is streamed through `node:zlib` to `<id>.log.gz` (0600) and the plain file
  is deleted; `bash_output` and the completion tail read it transparently. A
  task is killed, with the message `killed (log limit passed)` and a
  `__PI_BG_LIMIT__` marker ending its log, once its log passes 100 MiB; the size
  is checked four times a second, so a runaway is stopped just past the limit.
  `PI_BG_BASH_LOG_LIMIT_BYTES` lowers the limit for the contract test. At
  `session_start`, logs and emptied session directories older than 7 days are
  removed — never a running task's log or a directory owned by a live Pi, and
  never anything but the extension's own `bg-<n>.log` / `.log.gz` files.
- **Not honoured:** Pi's `shellPath` and `shellCommandPrefix` settings. An
  extension cannot read them, so neither background nor foreground commands
  use them.
- **Registry:** on `globalThis` under `Symbol.for("pi-bg-bash.registry")`, with
  one 2 s poller and a 250 ms stat-only log-limit check. A task ends when its
  marker appears, or when its pid is gone
  with no marker (exit unknown). A log that is missing also means exit unknown.
  Any other read error is retried on later ticks; once the pid is dead and five
  reads in a row have failed, the exit is unknown too. A single failure never
  hides a real exit. One task's failure, a stale footer context or a throwing
  `sendMessage` never stops the poller; a message that failed to send is
  retried on a later tick. A task is registered only after its spawn resolves.
- **Completion message:** one `pi.sendMessage` custom message per task,
  `deliverAs: "followUp"`, `triggerTurn: true`, with the id, command, exit
  state (`exited (code N)`, `killed (timed out)`, `killed (killed by user)`,
  `killed (log limit passed)`, or `exit unknown`, the same wording as
  `bash_tasks`), runtime and the last ~20 lines of output.
- **Footer:** `ctx.ui.setStatus("bg", "bg: N")` while N tasks run.
- A call without `background` is a foreground call; see below.

## Foreground calls and promotion

A call without `background` runs Pi's own `bash` (`createBashToolDefinition`'s
`execute`, built per call for the session's cwd) over a custom `operations.exec`
(`foreground.ts`). That `exec` launches the command through the same wrapper as
a background task, with Pi's shell, environment and `PI_*` variables as the
delegate resolved them, and feeds the log to `onData` (polled every 50 ms; a
trailing partial exit marker is held back, never shown). Output, truncation,
the error texts (`Command exited with code N`, `Command aborted`, `Command timed
out after N seconds`) and the `timeout` checks (`Invalid timeout: ...` for a value
that is not above 0 or exceeds 2147483.647 s) are Pi's. A `timeout` or an abort of
the turn, including one that lands while the process is being spawned, sends
SIGKILL to the command's process group at once, as Pi's bash does; only
`bash_kill` and `/bg` use SIGTERM, then SIGKILL after the grace period. A
foreground command that ends leaves no task and no log, and its id is given back.
After the exit marker the call keeps reading the log until it has been idle for
100 ms (reset on new output), so a short-lived background child's last writes are
kept, as Pi's bash keeps inherited-pipe output. A command that vanishes without an
exit marker ends the call with `Command terminated without an exit code`, its last
output kept.

- **Promotion:** a command still running 120 s after it started, with no
  explicit `timeout` and not starting with `sleep`, becomes a task: the same live
  wrapper is registered (id, footer `bg: N`, `bash_tasks`, one completion
  message, runtime counted from the start). `exec` then ends as if the command
  had exited 0, so Pi's bash closes its output and returns; the extension
  discards that result except for the text, which it wraps as
  `Command still running after 120 s; moved to the background as task <id>. ...
  Output so far: ...`. Nothing in Pi's bash is left pending. After promotion the
  turn's abort signal no longer reaches the process and no output flows to the
  finished call. A command that ends in the same instant ends normally.
  The task's `bash_output` continues after the output the promoted call showed
  (never re-read). A truncated output's "Full output" footer points at the task's
  log, not at Pi's temp file, which is deleted; the result carries no `details`.
  The text says how long the command had actually run.
- **Not promoted:** a command with any explicit `timeout` (killed at it) or one
  starting with `sleep`. `PI_BG_BASH_PROMOTE_MS` shortens the threshold, for the
  contract test.
- **Shortcut:** `ctrl+shift+b` moves the running foreground command to the
  background at once, without waiting the 120 s. It applies to any command,
  including `sleep` and ones with an explicit `timeout`. With no foreground
  command running it does nothing. `ctrl+b` is left to Pi as cursor-left. When
  several foreground commands run at once (parallel tool calls), one press
  promotes every one of them, since the turn stays blocked until they all
  finish.
- **Hint:** 2 s into a foreground command, a widget below the editor shows
  "(ctrl+shift+b to background)", so fast commands never flash it. The moment
  the command's exit marker is seen the hint timer is cancelled and a shown
  hint is cleared, before the 100 ms late-output grace; it is also cleared when
  the command is promoted, aborted, or times out. No widget is set when there is
  no UI. The show and clear are best-effort: a stale context's `hasUI`/`ui`
  getters throwing is ignored, and the call still ends.
- The one promotion path is
  `promote()` on each entry of `foregroundRuns()` (`foreground.ts`), the set of
  foreground calls in flight; the 120 s timer and the shortcut both call it.

## `bash_output`

`bash_output({ id, latest?, filter? })` reads a task's log — plain or gzipped,
running or finished.

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
  (`killed by agent`, `killed by user`, `timed out`, `log limit passed`) kept in the registry, and
  reported as `killed (reason)` by `bash_tasks`, `bash_output` and the completion
  message. The group kill also takes the wrapper down, so no exit marker is
  written and the log's exit marker stays digits-only; the log-limit kill appends
  a `__PI_BG_LIMIT__` marker instead, hidden from output like the exit marker.
  A task whose command exits while the limit kill is in flight is reported as
  `exited` with its code. Session end reports nothing (the tasks
  are forgotten), and Pi-gone is written by the watcher as `__PI_BG_GONE__:`,
  not as a registry reason.
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
  message saying `killed by user`; picking a finished one stops what it left
  running, if anything, and tells you. Without
  a UI it prints the list with `ctx.ui.notify` and kills nothing.

## Session lifetime

Tasks belong to the session that started them.

- **`/reload` keeps them.** Pi loads extensions with `moduleCache: false`, so a
  reload runs a fresh copy of the extension. It finds the `globalThis` registry,
  refreshes its `pi` reference and replaces the poller, so one poller runs and
  completions go through the newest registration, once. A foreground command in
  flight is left running too, and is still in `foregroundRuns()` (kept in the
  registry, not in module state); when it outlasts the threshold it is promoted
  as usual.
- **`quit`, `new`, `resume` and `fork` kill everything** (`session_shutdown`,
  awaited by Pi): the group kill (SIGTERM, grace, SIGKILL) on every task's group,
  finished ones too since a `server &` outlives its command, on every foreground
  command in flight, and on a spawn still under way, once it resolves. The
  tasks are then forgotten and their completion is never reported, since the
  session that wanted it is over.
- **A crash or hard kill of Pi** is caught by a separate watcher, its own `sh`
  process spawned detached outside the task's group right after the wrapper. It
  is given Pi's pid and the task's group, checks both about once a second, and
  exits when the group has emptied; when Pi is gone first and the group still
  has members, it appends `__PI_BG_GONE__:<nonce>` to the log and SIGKILLs them.
  So a `server &` a finished command left behind is covered here too, as well as
  by session end and `bash_kill`/`/bg`. No Pi is left to read the GONE marker, so
  `bash_output` does not know it. A watcher that fails to start leaves the task
  running without a crash watch (fail open).
- **`bash_kill` and a `/bg` pick on a task whose command has exited** run the
  group kill when anything is left in its group and say so (`had already
  finished: exited (code 0); stopped the processes it left running`, or that
  they survived SIGKILL). An empty group gives "already finished" as before.
  The task's state is not changed.

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

- **Behaviour tests** (`background`, `foreground`, `kill`, `logs`, `output`,
  `poller`): the extension
  runs over a scripted fake process table behind the process port, on
  `node:test` mock timers that start at the real now. The test decides when a
  task writes, exits (writing the marker with its nonce), traps SIGTERM, leaves a
  child or a zombie group, dies without a marker or survives SIGKILL. Logs are
  real files under a temporary `XDG_STATE_HOME`. `clock.settle(call)` ticks the
  clock until a call settles; no test awaits a timer-driven call without it.
- **Lifetime** (`lifetime`, behaviour tier): reload hand-over and the single
  poller, session-end kills (finished tasks, foreground in flight, pending
  spawn), the finished-task kill, and the pid-reuse guard.
- **Contract tests** (`contract`): the real port with short real `sh` commands
  on real time and no mock timers. The Pi-gone watch runs against a stand-in
  `sleep` as Pi's pid: a task dies when it is killed, a task stays alive past one
  watch period while Pi lives, and a child a finished command left behind dies
  with the GONE marker. Also covered: the watcher's default Pi pid and its exit
  once the group empties, a real session end, foreground parity with Pi's bash
  (including late output after the marker and a real promotion via
  `PI_BG_BASH_PROMOTE_MS`), quoting and heredocs, Pi's shell and environment, the
  marker and nonce (grandchild, spoofed marker, marker across a read window), the
  group kill (child, `trap '' TERM`), the errno mapping (including the macOS
  zombie-only group, macOS only), spawn failures and exclusive log creation,
  and the log limit (a task printing past `PI_BG_BASH_LOG_LIMIT_BYTES` is
  killed with the `__PI_BG_LIMIT__` marker). `PI_BG_BASH_GRACE_MS` shortens the
  kill's grace period.
