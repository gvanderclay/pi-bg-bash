# pi-bg-bash

A Pi extension that lets the model run shell commands in the background. It
replaces Pi's `bash` tool with the same tool plus a `background` flag: a call
with `background: true` starts the command detached, returns a task id at once,
and wakes the agent with the result when the command exits. Ordinary foreground
calls wait for the command to finish and return its output; they never move to the
background just because time passed. Only an explicit `waitFor` match or the
user's keyboard shortcut can promote a running foreground call.

## Install

You need:

- Pi on macOS or Linux (not Windows). Pi 1.0.0 is the version pi-bg-bash is
  tested with. Pi supplies the peer dependencies
  `@earendil-works/pi-coding-agent` and `typebox`.
- A POSIX `sh`. The command itself runs in Pi's own shell (bash when present).
- No other extension that replaces the `bash` tool or registers `/bg` or
  `ctrl+shift+b`. [pi-bg-tasks](https://www.npmjs.com/package/pi-bg-tasks)
  claims all three, so install only one of the two.

Install the package from npm:

```bash
pi install npm:pi-bg-bash
```

To follow the latest commit instead, install it from GitHub:

```bash
pi install git:github.com/gvanderclay/pi-bg-bash
```

The package has no runtime dependencies and no build step.

## First use

Ask the model for something that keeps running, for example "start the dev
server in the background and tell me when it is up". It calls `bash` with
`background: true` and gets back a task id such as `bg-1`. The footer shows
`bg: 1` while the task runs, and the model can read its output with
`bash_output` while it works on something else. When the command exits, the
agent receives one message with the exit state and the last lines of output,
which starts a turn if it was idle.

Run `/bg` to see every task: enter shows a task's output, and `x` kills it
after you confirm. Press
`ctrl+shift+b` while a foreground command runs to move it to the background
at once instead of waiting.

## What it adds

- The `bash` tool keeps Pi's parameters and adds `background`, `waitFor` and `hold`.
  Without `background: true`, a call waits in the foreground and returns normal
  output when the command exits. Explicit `timeout` and turn abort still stop it.
  Only an opt-in `waitFor` match or deliberate user shortcut can promote it. Its
  description tells the model to wait for something to finish (a CI run, a
  server coming up) with a blocking command such as `gh run watch <run-id>
  --exit-status` and `background: true`, never `sleep N` and then a check.
  The result of a call that goes on as a task tells the model to end its turn
  if nothing else is left, since the completion message starts its next one.
  `waitFor: "<text>"` (foreground only) returns as soon as the text appears in
  the output while the command keeps running as a task, for a server that
  should stay up.
- A codemode script's `await tools.bash(...)` resolves to Pi's bash object,
  `{ output, truncated, full_output_path?, exit_code?, wall_time_seconds, task_id? }`.
  When the command goes on as a task (`background: true`, a `waitFor` match
  or the user's `ctrl+shift+b`), `task_id` holds its id for `bash_output`
  or `bash_kill`, `exit_code` is absent, `output` holds the output so far (empty
  for `background: true`), and `full_output_path`, when the output was
  truncated, is the task's log.
- `bash_watch({ id, action?, contains? })` subscribes to output events while a task
  keeps running. It is a native tool, available outside codemode even in
  `codemode.only`. See [Output events and completion holds](#output-events-and-completion-holds).
- `bash_output({ id, latest?, filter? })` reads a task's output from where the
  last read stopped, or only the newest output, optionally filtered by a regex.
- `bash_tasks()` lists every task of the session with its state and runtime.
- `bash_kill({ id })` stops a task and everything it started.
- In a codemode script these three resolve to objects, not text (see
  [Structured results](#structured-results)), and these tools carry
  annotation hints for permission extensions.
- `/bg` lists the tasks; enter shows the selected task's output and `x` kills
  it after a confirmation.
- `ctrl+shift+b` moves the running foreground command to the background. It
  needs a terminal that reports modified keys (the kitty keyboard protocol or
  `modifyOtherKeys`); inside tmux, also `set -g extended-keys on`.

Tasks belong to the session that started them. `/reload` keeps them; quitting
or switching sessions (`new`, `resume`, `fork`) kills them, and if Pi crashes a
watcher process kills them. Logs live under
`$XDG_STATE_HOME/pi-bg/<session-id>/` (default `~/.local/state`) and are
removed after 7 days.

The rest of this README describes the behaviour in detail.

## Background tasks

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
- **Row timer:** the chat row of a `bash` call that started a task or was
  promoted to one replaces Pi's `Took Ns` line with when the task started,
  such as `Running since 2:14:13 PM` in the local time format, then, redrawn
  once when the task ends, how it ended, such as `Exited (code 0) after 4m 10s`
  or `Killed (timed out) after 2m 0s`. The row never counts up: redrawing a
  row that has scrolled off screen makes Pi clear and repaint the whole
  screen and scrollback, which flickers. A row
  whose task this Pi process does not know, such as one in a session resumed
  after a restart, keeps Pi's line.
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
  `deliverAs: "steer"`, `triggerTurn: true`, with the id, the command (on
  one line, newlines shown as ` ⏎ `, cut to 200 characters), exit state
  (`exited (code N)`, `killed (timed out)`, `killed (killed by user)`,
  `killed (log limit passed)`, or `exit unknown`, the same wording as
  `bash_tasks`), runtime and the last 20 lines of output, capped at 4 KiB.
  When the cap cut the output, its label says so and names `bash_output <id>`,
  which reads the whole log since the completion message never moves the read
  position. A busy agent gets the message when its current turn ends, before
  its next model request; one that ends while the agent writes its final
  answer still arrives after it. A
  `followUp` would be held until the agent stopped, so every task that ended
  during a run would arrive after its final answer, one turn each, and a
  delegate's reply would become its answer to the last of them.
- **Footer:** `ctx.ui.setStatus("bg", "bg: N")` while N tasks run.
- A call without `background` is a foreground call; see below.
- **Stripped output:** what the agent reads (the foreground result, `bash_output`
  and the completion message's tail) has ANSI escape codes, carriage returns and
  other control characters except newline and tab removed, the pipeline Pi
  applies to the user's `!` commands (`stripAnsi`, `sanitizeBinaryOutput`, then
  `\r` dropped; `sanitize.ts` carries an own copy, since Pi does not export
  them). Pi's own `bash` tool hands its output on unstripped, so the foreground
  result is stripped here too. The logs on disk stay raw, byte for byte.

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

- **Deliberate promotion:** an explicit `waitFor` match or the user's
  `ctrl+shift+b` turns the live command into a task. The same wrapper is registered
  (id, footer `bg: N`, `bash_tasks`, one completion message, runtime counted from
  the start). `exec` then ends as if the command had exited 0, so Pi's bash closes
  its output and returns; the extension keeps that text and structured output
  (its `exit_code` dropped, `task_id` added), prefixed with the reason and elapsed
  time described below. Nothing in Pi's bash is left pending. After promotion the
  turn's abort signal no longer reaches the process and no output flows to the
  finished call. A command that ends in the same instant ends normally.
  The task's `bash_output` continues after the output the promoted call showed
  (never re-read). A truncated output's "Full output" footer points at the task's
  log, not at Pi's temp file, which is deleted; the result carries no `details`.
  The text says how long the command had actually run.
- **`waitFor`:** a plain substring (not a regex) matched against the stripped
  output as it arrives, including across two reads and inside a line that has
  no newline yet. On a match the call is promoted through the same `promote()`,
  at once, even with an explicit `timeout`, and answers `"<text>" appeared after
  N s; the command keeps running as background task <id>. ... Output so far: ...`. An explicit `timeout` then
  becomes the task's deadline (`startedAt` plus `timeout`, as for
  `background: true`); until a match it still kills the foreground call at the
  `timeout`. If the call ends without a match (the command exits, the user
  presses `ctrl+shift+b`, or it fails), the result also says
  `"<text>" never appeared in the output.`. `waitFor` with `background: true`
  and an empty `waitFor` are tool errors before anything starts. A match sends
  no message of its own; the completion message comes when the task ends. An
  escape sequence split across two reads is not stripped before matching.
- **No automatic promotion:** elapsed time and command spelling never turn an
  ordinary foreground call into a task. The former `PI_BG_BASH_PROMOTE_MS`
  variable is ignored; it no longer enables a timed move to the background.
- **Shortcut:** `ctrl+shift+b` moves the running foreground command to the
  background at once, when the user deliberately requests it. It applies to any
  command, including `sleep` and ones with an explicit `timeout`. The call answers
  `The user pressed ctrl+shift+b after N s: this command was deliberately
  moved to the background as task <id>, so you are not blocked on it. Do not
  run it again or start a sleep in its place. ...`. With no foreground
  command running it does nothing. `ctrl+b` is left to Pi as cursor-left. When
  several foreground commands run at once (parallel tool calls), one press
  promotes every one of them, since the turn stays blocked until they all
  finish. `ctrl+shift+b` needs a terminal that reports modified keys, through
  the kitty keyboard protocol or `modifyOtherKeys`; inside tmux it needs
  `extended-keys on` as well (`set -g extended-keys on`).
- **Hint:** 2 s into a foreground command, a widget below the editor shows
  "(ctrl+shift+b to background)", so fast commands never flash it. The moment
  the command's exit marker is seen the hint timer is cancelled and a shown
  hint is cleared, before the 100 ms late-output grace; it is also cleared when
  the command is promoted, aborted, or times out. No widget is set when there is
  no UI. The show and clear are best-effort: a stale context's `hasUI`/`ui`
  getters throwing is ignored, and the call still ends.
- The one promotion path is
  `promote()` on each entry of `foregroundRuns()` (`foreground.ts`), the set of
  foreground calls in flight; only a `waitFor` match or the user's shortcut calls it.

## Debug log

Set `PI_BG_BASH_DEBUG=1` (the value `1` exactly, read on every write) to append
diagnostics to `$XDG_STATE_HOME/pi-bg/debug.log` (default
`~/.local/state/pi-bg/debug.log`, mode `0o600`). Without it nothing is written
and nothing else changes. A failed write to the log is dropped, never raised.

- **Format:** JSON Lines. Every line has `t` (ISO timestamp) and `event`;
  task lines add `task`, `session`, `pid` and `command` (on one line, as in
  `bash_tasks`).
- **Events:** `task-start`, `task-exit` (`state`, `exitCode`), `kill-request`
  and `kill` (`reason`, `outcome`; a log-limit kill has that `reason`),
  `deadline`, `promote` (`by: "shortcut"` or `"waitFor"`, `elapsedMs`),
  `session-end` (the task count and the groups it kills, with an `error` line
  for each kill that fails) and `rotate`.
- **Errors:** every error the extension swallows or downgrades is an `error`
  line with `where` (a short tag), `error` (the message), `code` and `stack`.
  Two expected cases are not logged: ESRCH/EPERM from signalling a group that
  is gone, and a missing file where absence is ordinary (the owner marker, the
  log-size check of a deleted log).
- **Rotation:** at `session_start`, a `debug.log` over 5 MiB is renamed aside
  (so only one Pi process rotates it), gzipped to `debug.log.1.gz`, and the
  older generations shift up; five are kept, `debug.log.5.gz` the oldest. The
  7-day cleanup never touches these files.

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
- The position counts raw log bytes, so invalid UTF-8 does not lose lines. The
  text returned is stripped (see above) after the page is cut from the raw log.
- `filter` is a regex applied to the stripped lines returned, so escape codes
  do not break a match; the position still moves past every line read,
  matching or not.
- The exit marker is never output. The first line reports the task, worded as
  in `bash_tasks`: `running`, `exited (code N)`, `killed (reason)` or `exit unknown`.
- An unknown id, or an invalid filter, throws, which Pi reports as an error
  result.
- The completion message's tail is separate and never moves the position.

## Structured results

`bash_output`, `bash_tasks` and `bash_kill` declare an `outputSchema` and return
a matching `structuredContent`, so a codemode script gets an object; the model
still reads the text. A task is described by `task_id`, `state` (`running`,
`exited`, `killed` or `exit-unknown`), `exit_code` only when `exited` and
`reason` only when `killed`, the same state the text reports.

- `bash_output`: the state fields plus `output` (the text returned, after
  `filter`; empty when nothing was), `truncated` (more is left, or `latest`
  skipped some) and `unread_bytes` (raw log bytes not yet read). `state` comes
  from the exit marker this read saw, so a task is done when `state` is not
  `running` and `unread_bytes` is 0.
- `bash_tasks`: `{ tasks }`, each with the state fields, the full `command`,
  `started_at_ms`, `ended_at_ms` once ended, and `runtime_ms`.
- `bash_kill`: one such task plus `outcome`: `killed`, `finished` (had already
  ended), `gone` (had already ended, exit unknown), `cleared` (had ended; what it
  left running was stopped), or `stuck` / `leftover-stuck` (survived SIGKILL).

Annotations: `bash` is destructive and open-world; `bash_output` changes only
the read position (not read-only, not destructive); `bash_tasks` is read-only
and idempotent; `bash_kill` is destructive and idempotent. None but `bash`
is open-world.

## Output events and completion holds

The output-event capability is tested with Pi 1.4. Start the command through the
existing `bash` tool with `background: true`, then call the native `bash_watch`
tool with its id. Launch permissions still apply to the original bash command;
the subscription cannot launch, adopt or kill processes, or read arbitrary paths.

`bash_watch({ id, action?: "start" | "stop", contains?: string[] })`:

- `start` is the default. It returns immediately and sends new output as steering
  messages at the next tool gap, or starts a turn when idle. The task keeps the
  same process; a subscription does not interrupt a foreground tool call.
- Replay begins at the start of the log, independently of `bash_output`. If the
  log already exceeds 256 KiB, replay starts in its last 256 KiB, discards the
  first cut line and reports skipped bytes. At most 16 watches may be active.
- `contains` keeps lines containing any of 1–16 literal, case-sensitive
  substrings, each at most 256 UTF-8 bytes. It is not a regex. Omit it for all
  nonempty lines. Matching uses the stripped output.
- A complete LF-terminated line is emitted even if the producer then goes silent.
  Split UTF-8 and ANSI sequences within that line are retained until framing.
  Invalid UTF-8 becomes replacement characters without changing byte offsets.
- Output messages label the command output as data, not instructions. Each
  JSON-string-framed record includes `task_id`, `seq`, `from_byte`, `to_byte`,
  `text` and `partial`. Byte offsets use the marker-removed raw log. Repeated
  equal lines are separate events; consumers deduplicate their own workflow actions.
- The poller reads at most 64 KiB per watch and 256 KiB total per tick, round-robin.
  Lines over 16 KiB raw or stripped are discarded through their LF. Pending output
  is capped at 32 records and 32 KiB of JSON per watch, and each message at 32 KiB,
  including its header. A record whose escaped JSON cannot fit is discarded.
- Only one output message per session may be sent but not yet seen in request
  context. Further output coalesces locally, dropping the oldest records when
  necessary. Messages report cumulative `skipped_bytes`, `dropped_lines` and
  `oversized_lines`, with sequence numbers showing which event lines were kept.
  Delivery is bounded, not lossless. Recheck current external state after a gap;
  do not infer that an omitted event succeeded. No output notification moves
  `bash_output`'s read position.
- An aborted or failed agent run pauses unsolicited output wakes and recovery of
  lost held-completion messages. A new user run, or a run started by another
  extension's message, resumes them. Initial completion delivery and unheld
  completion behavior are unchanged.
- If Escape, abort or an RPC queue clear discards a queued output batch, the same
  batch/token is re-armed after the run settles. A held task's unseen completion
  is likewise retained and retried with its original bounded payload/token; retries
  respect the stop/error pause. Messages already included in request context are
  not re-sent, even if that run was aborted. Their held completion still needs a
  later normal run to commit observation. Queue-count APIs are not used to infer
  delivery, since they omit custom steering messages.
- `stop` permanently unsubscribes output for that task. Starting the same active
  configuration is idempotent; restarting a stopped watch or changing its filter
  is refused. Use `bash_output` for later reads. Stop does not kill the command.
- Starting on an already-ended task reports `ended` and its state; it does not
  replay a compressed historical log. Read `bash_output` instead.
- A shrinking log stops its watch with a gap. Read failures are retried; running
  log rotation is not supported. Watch polling never reads gzip files.
- Completion takes precedence over output. Before the ordinary completion message,
  the watch makes one bounded final scan and closes. Final unterminated text is
  classified as partial; buffered event records not already sent are discarded.
  The completion message for a watched task reports undelivered lines and gaps
  and points to `bash_output`. Compression then works as before.

`bash_watch` has Pi exposure `model-only`: the model calls it directly, even with
`codemode.mode: "only"`; scripts cannot call `tools.bash_watch`. Its structured
result reports the task state, `watch_state` (`active`, `stopped`, `ended` or
`absent`), and the three cumulative gap counters. Permission extensions can
authorize this tool separately. Delegation tool ceilings must include its exact
name at each intended writable owner; registering it only in a child does not
bypass a parent's ceiling.

### Optional completion hold, atomic with launch

A running background task does not ordinarily prevent a delegated session from
reporting its final answer or exiting. For an operation that must keep that
owner's task unfinished, use `bash({ command, background: true, hold: true })`.
The default is false. `hold: true` requires `background: true` and a live completion
host registered for the exact current session. Without one it fails **before
spawn**; a failed spawn refunds its provisional hold.

A completion host, such as a compatible Squire implementation, checks all holds
before publishing its final task reply/tree completion or auto-exiting. No model
request loop is created merely to wait. The hold becomes ready only after the
task's terminal notification was included in a request and the agent run ended
normally. An unseen terminal, abort or provider error does not release it.
A successful `bash_kill` result also counts, including the top-level codemode
result when kill was nested in a script, even if the script later throws: the
recorded kill succeeded, but a normal agent run end is still required. `stuck`
and `leftover-stuck` do not;
a later successful kill is the recovery path.

A hold is not a success predicate: exit errors and cancellation can release it
once processed, and natural-exit leftovers do not delay it. The owner must inspect
the outcome and confirm cleanup with `bash_kill` when needed. Session shutdown
still kills all tracked groups, including leftovers. Stopping output does not
release a launch hold. Passive servers should normally use the default, no hold.

The host/provider interface is process-local data at
`globalThis[Symbol.for("pi.completion-holds.v1")]`:

```ts
{
  version: 1,
  hosts: Map<sessionId, Map<hostName, runtimeToken>>,
  holds: Map<sessionId, Map<holdId, { provider: string; ready: boolean }>>
}
```

A host registers a fresh runtime token only after acquiring its current session,
and removes only that token on every shutdown, including reload. Providers own
their hold entries; hosts read them and fail closed on malformed current-session
data. This extension checks live exact-session host presence before launch, writes
its own provisional entries, and marks them ready after observation. Reload
preserves task/watch cursors, random notification tokens and holds. Non-reload
shutdown removes this provider's entries and clears subscriptions while keeping
the existing process cleanup contract. There is no restart/reopen recovery,
durable scheduler, cross-session subscription or automatic forge action.

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
- `/bg`: in the terminal UI, a list of every task (same line as `bash_tasks`),
  running tasks first, then the most recently started.
  Enter shows the end of the selected task's log, stripped like `bash_output`
  and capped like it (2000 lines or 50 KiB), opened at the bottom and scrolled
  with the arrows, page up/down, home and end; it re-reads the log every second
  and follows new output while it is at the bottom (scrolled up, it keeps its
  place), and never moves `bash_output`'s read position. The list refreshes
  every second too, keeping the selected task. `x` asks `Kill <id>?` (for a
  finished task, `Stop what <id> left running?`), showing the command on one
  line (newlines as `⏎`, cut to 200 characters), and on yes runs the group kill:
  a running task gets the completion message saying `killed by user`, a finished
  one has what it left running stopped, and you are told what happened. Esc in
  the output goes back to the list, which comes back after a kill too, with the
  tasks' current state; `q` or esc in the list closes it. In RPC mode, which has no
  custom components, `ctx.ui.select` over the tasks, and a pick asks the same
  confirmation before the kill. Without a UI it prints the list with
  `ctx.ui.notify` and kills nothing.

## Session lifetime

Tasks belong to the session that started them.

- **`/reload` keeps them.** Pi loads extensions with `moduleCache: false`, so a
  reload runs a fresh copy of the extension. It finds the `globalThis` registry,
  refreshes its `pi` reference and replaces the poller, so one poller runs and
  completions go through the newest registration, once. A foreground command in
  flight is left running too, and is still in `foregroundRuns()` (kept in the
  registry, not in module state), waiting normally unless a `waitFor` match or
  the user's shortcut deliberately promotes it.
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
- **`bash_kill` and a `/bg` kill on a task whose command has exited** run the
  group kill when anything is left in its group and say so (`had already
  finished: exited (code 0); stopped the processes it left running`, or that
  they survived SIGKILL). An empty group gives "already finished" as before.
  The task's state is not changed.

Uses no `pi.events` hook.
