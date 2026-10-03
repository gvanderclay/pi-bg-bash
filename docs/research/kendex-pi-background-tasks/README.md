# kendex `pi-background-tasks` compared with pi-bg-bash

**Question.** What does the Pi extension at
`vanillagreencom/kendex/pi-extensions/pi-background-tasks` do, how is it
built, and which of its features, design choices or robustness measures are
worth copying into pi-bg-bash?

**Short answer.** kendex's extension is a large (about 6,300 lines in
`extensions/`) *separate-tool* design: `bg_task` and `bg_status` tools, tasks
that are allowed to outlive Pi and are re-adopted on the next session, a
dashboard, and a wake system that can also notify on matching output. pi-bg-bash
is the smaller, stricter design (the `bash` tool plus a flag, tasks die with the
session, output goes straight to a file) and already does better on kill
escalation, crash cleanup, foreground promotion, incremental reads and
ANSI stripping. Only four things are worth copying, all small: (1) a
one-shot "wake me when this output appears" option, because pi-bg-bash's own
README example ("tell me when it is up") cannot be met without polling; (2) a
cap on the command text echoed in the completion message; (3) a time limit on
the model-supplied `filter` regex; (4) an opt-in diagnostics log. The
persistence, orphan-watcher, log-writer, dashboard and resource-control
machinery should not be copied. The ranked list is in § 4.

**Checked.** 2026-10-03 (local clock `date`). kendex `main` at commit
`45621a58f68e502ba91d46e9a82a8fcfd675abe0` (commit date 2026-10-03T13:51:06Z);
the last commit touching the package directory is
`373bb6ad4eb732cabbacf58518c7ce1ba6e778a5` (2026-10-01T14:28:26Z). Package
version 2.1.2. pi-bg-bash at `57f33ea6ef5d3209a6daf2da6a0cb675475ccd29`
(v0.1.2), Pi `@earendil-works/pi-coding-agent` 1.0.0 as installed in
`node_modules`. All kendex files were read from a tarball of that commit
(`gh api repos/vanillagreencom/kendex/tarball/45621a58…`).

**Notation.** `K:` paths are under `pi-extensions/pi-background-tasks/` at
kendex `45621a58`; `ext/` abbreviates `extensions/`. `P:` paths are in
pi-bg-bash at `57f33ea`. Claims are numbered `[K#]` (kendex) and `[P#]`
(pi-bg-bash). Everything here comes from source files, kendex's own README,
DEVELOPMENT.md, CHANGELOG.md, and its GitHub issues/PRs (first party); there
is no secondary source.

---

## 1. What kendex's extension is

### Shape and provenance

- [K1] Package `@vanillagreen/pi-background-tasks` 2.1.2, MIT, Node ≥ 22.19,
  tests run with `bun test`; entry `./extensions/background-tasks.ts`
  (`K:package.json`). It is "based on ideas and portions of"
  `@ifi/pi-background-tasks` (`K:THIRD_PARTY_NOTICES.md:3`).
- [K2] It is one 1,129-line closure (`K:ext/background-tasks.ts`) plus 26
  helper modules (`wc -l`: 6,290 lines in `ext/*.ts`). The biggest parts are
  wake logic (`wake-events.ts`, 619), settings plumbing (`package-config.ts`,
  445), resource control (`resource-control.ts`, 414), dashboard (333) and
  render (377).

### Tools, command, shortcuts (model- and user-facing)

- [K3] Two model tools. `bg_status` has `action: list | log | stop` and `pid`
  (`K:ext/registrations.ts:46-81`). `bg_task` has
  `action: spawn | list | log | stop | clear` and `command`, `cwd`, `id`,
  `notifyOnExit`, `notifyOnOutput`, `notifyPattern`, `notifyMode`, `dedupeKey`,
  `pid`, `timeoutSeconds`, `title` (`K:ext/registrations.ts:96-113`). The two
  overlap: both can list, log and stop.
- [K4] The model never gets the existing `bash` tool's behaviour changed by a
  flag. Instead a `tool_call` hook rewrites a `bash` call's `command` into
  `printf '%s\n' '<acknowledgement>'` after starting the real command as a task
  (`K:ext/background-tasks.ts:1057-1080`; `ext/auto-background.ts:146-148`), so
  the original `bash` call "runs" an echo. The `user_bash` event (the user's
  `!` commands, also RPC bash) gets the same treatment and returns a synthetic
  result (`K:ext/background-tasks.ts:1082-1106`;
  `K:DEVELOPMENT.md:25`).
- [K5] What gets auto-backgrounded is decided from the command *text*, not from
  elapsed time: user patterns (setting `autoBackgroundPatterns`), `watch …`,
  `tail -f` / `journalctl -f`, `sleep ≥ 5` combined with
  tmux/pi-bridge/session words, and `for/while/until … sleep …` loops that are
  open-ended, over 30 iterations, or look like a session monitor
  (`K:ext/auto-background.ts:54-117`).
- [K6] A shortcut (`alt+.` by default) or `/bg next` *arms* the next not-yet-
  started `bash` call (5-minute window) to be backgrounded. The notification
  itself says "Already-running bash cannot be detached safely"
  (`K:ext/background-tasks.ts:965-973`; defaults
  `K:ext/constants.ts:2,39`).
- [K7] Slash commands: `/bg` (opens the dashboard) with sub-commands `list`,
  `next`, `run <cmd>`, `log <id>`, `watch <id>`, `stop <id>`, `clear`, with
  argument completion on task ids, plus `/bg:list`, `/bg:next`, `/bg:clear`,
  `/bg:run`, `/bg:stop` (`K:ext/registrations.ts:188-276`).
- [K8] Shortcuts: dashboard `alt+shift+h` and always `f5`, widget toggle
  `alt+h`, force-background `alt+.`; each can be set to `none`
  (`K:ext/constants.ts:2-4`; `K:ext/registrations.ts:279-316`).

### Model-facing text

- [K9] `bg_task` description: "Spawn, inspect, and stop explicit background
  shell tasks without blocking the current turn. Tasks write persistent logs,
  do not time out by default, stop as a process group on Unix, and can wake the
  agent on exit or matching output. The background-tasks extension also
  auto-diverts recognized bash monitoring loops before they block."
  (`K:ext/registrations.ts:87-88`). Four `promptGuidelines` follow
  (`:90-95`), e.g. "Use bg_task for pi-bridge, session, tmux, agent/delegate,
  or log monitoring instead of raw foreground bash polling loops."
- [K10] A longer contract, `K:instructions.md`, is appended to the system prompt
  (`appendSystem` in `K:package.json:18`; npm `postinstall` runs
  `scripts/append-system.mjs install`, `K:package.json:22`, which edits the
  user's or project's `APPEND_SYSTEM.md`, `K:scripts/append-system.mjs:1-24`).
  It carries three rules worth noting: "Never spawn a task and then wait on its
  output in foreground" (`instructions.md:21`); "Stop tasks you started for a
  turn-scoped purpose before finishing the turn" (`:22`); and the wake-budget
  explanation (`:24`).
- [K11] Injected messages (all via `pi.sendMessage`, `display: true`): exit wake
  `Background task <id> finished.\nCommand: <≤160 chars>` with a compact
  `details` manifest (`K:ext/wake-events.ts:522-535`); output wake
  `… emitted new output.`; a one-time "output wake budget exhausted" notice that
  names the log file and says to use `bg_task log`
  (`K:ext/wake-events.ts:583-587`); a one-time "notify pattern exceeded 25 ms"
  notice (`:549-567`). Spawn result text lists id, pid, command, cwd, **log
  path**, expiry and wakeup settings, each field cut at 192 characters
  (`K:ext/registrations.ts:135-148`; limit `K:ext/wake-events.ts:380`).

### Process handling

- [K12] Spawn: the user's shell from Pi's `getShellConfig`, the command as one
  argument, `detached: true` on POSIX, `stdio: ["ignore","pipe","pipe"]`, Pi
  reads the pipes (`K:ext/background-tasks.ts:772,805-810`). The comment block
  explains `detached` was added for kendex issue #97 (tasks "sometimes marked
  stopped externally"): own session/process group, so Pi's death or a dead tmux
  pane does not signal the child (`:783-804`). Issue #97 closed `completed`
  on 2026-05-17 with no comments (`gh api repos/vanillagreencom/kendex/issues/97`);
  its root cause was never reproduced in the issue text (the issue lists three
  hypotheses).
- [K13] Stop: `process.kill(-pid, SIGTERM)` to the group (plain pid on Windows),
  then a timer sends SIGKILL after `forceKillGraceMs` (default 5 s,
  `K:ext/constants.ts:22`) and appends `[stop] Escalating to SIGKILL…` to the
  log (`K:ext/background-tasks.ts:675-757`). Stop is refused and reported if a
  non-ESRCH kill error occurs, and the task stays `running`
  (`:733-745`). Nothing waits for the group to actually vanish; the status
  becomes final when the child's `close` event fires (`:913`).
- [K14] `session_shutdown` sends SIGTERM then SIGKILL back-to-back with no
  grace to every running task, marks them `stopped`, and persists
  (`K:ext/background-tasks.ts:1021-1055`). So a clean Pi exit kills tasks;
  tasks outlive Pi only after a crash or hard kill.
- [K15] Timeout: default none (`DEFAULT_TIMEOUT_MS = 0`,
  `K:ext/constants.ts:20`); `timeoutSeconds` runs the same stop path with
  reason `timeout` (`K:ext/background-tasks.ts:919-925`).
- [K16] Optional resource control (`resourceControlEnabled`, default off): wraps
  the spawn in a `systemd-run --user` transient unit or `nice`/`ionice`;
  Linux only; the unit name is persisted so stop targets the unit
  (`K:ext/resource-control.ts:1-140`; `K:DEVELOPMENT.md:10`).
- [K17] Orphan cleanup on session end is the kill in [K14]. There is **no
  crash watcher** that kills children when Pi dies: the design is the opposite.
  A restored task whose pid is alive (same pid and process start time, from
  `/proc/<pid>/stat` field 22 or `ps -o lstart=`) is rehydrated as `running`
  and an orphan watcher polls every 30 s until the pid is gone, then fires the
  exit wake; the watcher "observes and never signals"
  (`K:ext/orphan-watcher.ts:1-25,54`; `K:ext/snapshot.ts:110-176,193-218`;
  `K:DEVELOPMENT.md:9`).

### Output handling

- [K18] Output goes through Pi: `child.stdout/stderr.on("data")`; each chunk is
  appended to an in-memory string (capped at `outputBufferMaxChars`, default
  1,000,000) and queued to the log writer
  (`K:ext/background-tasks.ts:887-911`; `K:ext/format.ts:43-51`;
  `K:ext/constants.ts:23`).
- [K19] The log writer batches appends every 250 ms with one async write in
  flight per file; at 1 MiB pending it writes at once; at 4 MiB pending behind
  a write it returns a "hold" and the task *pauses its pipes* so the child
  blocks; a write in flight longer than 2 s counts as stalled and further text
  is dropped and counted into a `[log dropped N bytes: …]` marker
  (`K:ext/log-writer.ts:1-35,181-203`).
- [K20] After exit and a log flush, the task drops its in-memory output and
  process handle if the log write settled (`K:ext/background-tasks.ts:608-626`).
- [K21] Reads are tail-only. `log` returns the last `logTailMaxChars` (default
  10,000) characters, prefixed `[...truncated]` and suffixed with the log path
  (`K:ext/format.ts:24-41`; `K:ext/constants.ts:38`). There is no read cursor,
  no "only new output" mode and no filter. The async tail reader reads at most
  `3*maxChars+1` bytes, caches by file metadata, and shares four disk-read
  slots (`K:ext/log-tail.ts:19-95`).
- [K22] No ANSI or control-character stripping was found: a search of
  `extensions/` for ANSI/escape handling matched only UI colour helpers
  (`rg -n -i "ansi|\\x1b|\\u001b"` outside constants/glyphs/render/dashboard
  returned only unrelated words such as "transition"). Raw output reaches the
  model. This is a negative finding from a text search, not a proof.
- [K23] Persistent logs live in `$TMPDIR/kendex-pi-bg/lanes/<session-id>/`
  (or `taskDir` / `PI_BG_TASK_DIR`). At session start, a session's directory is
  removed if its recorded working directory is gone (a merged worktree) and any
  file older than 5 days is removed; only real, same-uid directories carrying a
  `.lane-cwd` record are touched (`K:scripts/lane-retention.ts:16-186`;
  `K:README.md` "Memory and disk use"). At most 50 finished tasks are kept; the
  oldest finished task is dropped with its log (`K:ext/constants.ts:26`;
  `K:ext/background-tasks.ts:301-311`).

### Notifications

- [K24] Exit wake: `deliverAs: "followUp", triggerTurn: true`; output wakes and
  notices: `deliverAs: "steer", triggerTurn: true`
  (`K:ext/wake-events.ts:534,567,609`). The tail is capped at
  `outputAlertMaxChars` (default 2,000) (`K:ext/constants.ts:33`).
- [K25] Output wakes are opt-in per task (`notifyOnOutput`), debounced by
  `outputSettleMs` (1.5 s), gated by a substring or `/regex/flags` pattern, and
  governed by `notifyMode`: `always`, `transition` (only when a SHA-256 of the
  new tail changes, optionally shared via `dedupeKey`) or `first-match-only`
  (default when a pattern is given, `transition` otherwise)
  (`K:ext/wake-events.ts:67-87,260-318`;
  `K:ext/background-tasks.ts:498-590`).
- [K26] A per-task budget (default 20 wakes / 20,000 bytes) suppresses further
  output wakes and sends one exhaustion notice. It was added in response to
  issue #210: the earlier defaults (10,000-char tails, `always` mode, 50,000-char
  log tails) could grow the session transcript until the provider rejected it
  (`K:ext/constants.ts:41-47`; `gh api …/issues/210`, opened 2026-05-21,
  closed). Exit wakes ignore the budget (`K:DEVELOPMENT.md:8`).
- [K27] The pattern matcher compiles and runs the regex inside `node:vm` with a
  25 ms timeout, disables a pattern that exceeds it and reports once
  (`K:ext/format.ts:77-134`; changelog 2.1.2, `K:CHANGELOG.md:5-7`; PR #3360).
  The author notes the deadline is proven under Node, not Bun
  (`K:DEVELOPMENT.md:21`).
- [K28] Exit wakes are durable and exactly-once: each snapshot has
  `exitNotified`; on `session_start` terminal tasks with `exitNotified === false`
  and `notifyOnExit` are replayed (`K:ext/snapshot.ts:129-140`;
  `K:ext/lifecycle.ts:83-119`). This exists because of issues #15 and #97:
  tasks went to `stopped` with `exitCode: null` and nothing woke the agent
  (`gh api …/issues/15`, opened 2026-05-12).

### Persistence across sessions

- [K29] Task state is written two ways on each lifecycle change: a Pi custom
  entry (`pi.appendEntry`, type `kendex-background-tasks:state`, skipped when the
  fingerprint is unchanged, degraded to a tiny manifest above 64 KiB) and an
  atomic temp-file+rename sidecar at
  `~/.pi/agent/kendex/sessions/<id>/pi-background-tasks/state.json`
  (`K:ext/persistence.ts:30-36,136-161,183-272`). `bg_task`/`bg_status` tool
  results also carry bounded task manifests, restored as a second source
  (`K:ext/tool-result-details.ts:1-30`; `K:ext/background-tasks.ts:234-244`).
  On restore, snapshots from other sessions are shown but never replayed
  (`K:ext/snapshot.ts:246-258`).

### UI

- [K30] A mini-dashboard widget above (or below) the editor with a summary line
  and up to three task rows (compact) or all (expanded), clamped so it cannot
  push the editor off-screen; finished tasks leave it after 15 s; toggled with
  `alt+h` (`K:ext/background-tasks.ts:126-140,337-367`;
  `K:ext/constants.ts:40,60`; `K:ext/widget-visibility.ts:1-25`). A full modal
  dashboard (task list, log tail, stop, clear) opens with `/bg` or `alt+shift+h`
  / `f5` (`K:ext/dashboard.ts`, 333 lines; `K:README.md` "Features").
  Rendering is throttled (200 ms output refresh, 1 s output persist) and the
  widget deliberately has no recurring redraw
  (`K:ext/background-tasks.ts:142-145,391-393`).
- [K31] A custom message renderer shows wake messages
  (`K:ext/background-tasks.ts:991`).

### Configuration

- [K32] About 30 settings, read from `.pi/settings.json` /
  `~/.pi/agent/settings.json` under
  `kendex.extensionManager.config["@vanillagreen/pi-background-tasks"]`, cached
  for 1 s (`K:README.md` "Settings"; `K:CHANGELOG.md` 2.0.3). Environment
  variables: `PI_BG_TASK_DIR`, `PI_BG_TASK_DEBUG`, `PI_BG_TASK_DIAGNOSTICS`,
  `PI_BG_TASK_DIAGNOSTIC_LOG` (`K:ext/settings.ts:34-37`;
  `K:ext/diagnostics.ts:5-16`). Diagnostics write only to a file, never the
  terminal (`K:ext/diagnostics.ts:18-28`).

### Issue history that explains the design

- [K33] The robustness code answers specific incidents: #15 and #97 (silent
  `stopped` with no wake, root cause not isolated), #210 (unbounded wake
  payloads), #177/#183/#184/#187 (session JSONL growth from snapshots and
  tool-result details), PR #3232 (synchronous per-chunk log writes and
  blocking probes), PR #3360 (bounded log reads and regex deadline)
  (`gh search issues|prs --repo vanillagreencom/kendex`; PR titles quoted from
  that listing).

---

## 2. What pi-bg-bash does today (confirmed against source)

- [P1] `bash` is Pi's own tool definition plus a `background` boolean; the
  description appends the background guidance
  (`P:src/index.ts:41-65`, text `:19-26`). Tools `bash_output`, `bash_tasks`,
  `bash_kill`, command `/bg`, shortcut `ctrl+shift+b` (`P:src/index.ts:31,66-145`).
- [P2] The command runs in a `sh` wrapper spawned `detached`, with **stdout and
  stderr on a file descriptor** of the log, `unref()`ed; the command is passed
  as an argument; an exit marker with a per-task nonce is appended
  (`P:src/launch.ts:36-40,166-183`). Pi never reads a pipe.
- [P3] A separate detached watcher `sh` outside the task group polls Pi's pid
  and the group once a second; if Pi dies first it appends `__PI_BG_GONE__` and
  SIGKILLs the group (`P:src/launch.ts:50-51,188-198`).
- [P4] Kill: SIGTERM to the group, wait up to 3 s polling every 100 ms, SIGKILL,
  wait 1 s more, report `stuck` if the group is still alive; refuses pid ≤ 1
  (`P:src/kill.ts:9-43`).
- [P5] Session end (`quit/new/resume/fork`) runs the group kill on every task's
  group, waits for spawns in flight first, marks tasks notified, forgets them;
  `/reload` keeps them (`P:src/registry.ts:135-157`; `P:src/index.ts:150-153`;
  `P:README.md:272-297`).
- [P6] Foreground calls run Pi's bash over the same wrapper; after 120 s without
  an explicit `timeout` (and not starting with `sleep`) the live process is
  *promoted* to a task without restarting it; `ctrl+shift+b` promotes at once
  (`P:src/foreground.ts:29,63-66`; `P:README.md:145-201`).
- [P7] `bash_output` is incremental: read position per task, `latest`, regex
  `filter` on stripped lines, Pi's truncation limits
  (`P:src/output.ts:29-60`; `P:README.md:203-226`). Output the model reads is
  ANSI/control-stripped; logs stay raw (`P:src/sanitize.ts:1-31`).
- [P8] Completion message: one `sendMessage`, `deliverAs: "followUp"`,
  `triggerTurn: true`, with id, state, runtime, **the full command**, and the last
  20 lines capped at 4 KiB; sent once, retried on a later tick if the send
  throws (`P:src/notify.ts:7-12,76-99`; `P:src/registry.ts:489-504`).
- [P9] Logs: `$XDG_STATE_HOME/pi-bg/<session>/<id>.log`, dir 0700, file 0600,
  created exclusively, `owner.pid` marker, gzip after completion, 100 MiB
  runaway kill checked 4×/s, 7-day cleanup limited to its own filenames and
  skipping symlinks and live owners
  (`P:src/launch.ts:53-80`; `P:src/logs.ts:24-60,105-170`;
  `P:src/registry.ts:21-23`).
- [P10] UI: a footer status `bg: N` (`P:src/registry.ts:36-43`) and a hint
  widget during foreground commands (`P:src/foreground.ts:31-34,248`); `/bg`
  is a `ui.select` over tasks that kills the pick (`P:src/index.ts:126-145`).
- [P11] Configuration is a handful of `PI_BG_BASH_*` environment variables for
  tests (`P:src/kill.ts:16`; `P:src/logs.ts:35`; `P:src/foreground.ts:63-66`).
- [P12] Two weaknesses seen while comparing (not from kendex):
  `bash_output` filter compiles `new RegExp(options.filter)` and runs it on
  each line synchronously (`P:src/output.ts:29-35,39-43`), and a finished,
  gzipped log is read whole with `gunzipSync(readFileSync(...))` on every
  `bash_output` call, a cost the code itself notes can exceed 100 MiB
  (`P:src/logview.ts:151-159`).
- [P13] The README's first-use example is "start the dev server in the
  background and tell me when it is up", but the only automatic message is the
  one on exit (`P:README.md:36-44`). Output-based readiness has to be polled
  with `bash_output`.
- [P14] pi-bg-bash has no output-triggered wakes and no per-task cap on how
  many finished tasks are kept: `registry.tasks` is a plain `Map`
  (`P:src/registry.ts:71`), and `bash_tasks` lists all of it
  (`P:src/index.ts:92-96`). `unknown` whether a long session hits a practical
  limit.

---

## 3. Area-by-area comparison

"Better" = pi-bg-bash does it better; "Covers" = equivalent; "Lacks" = kendex
has something pi-bg-bash does not.

| Area | kendex | pi-bg-bash | Verdict |
| --- | --- | --- | --- |
| Tool surface | Two tools with overlapping actions; `bash` left alone, its calls rewritten to `printf` ([K3],[K4]) | One `bash` tool plus flag, three small tools ([P1]) | **Better** (fewer tools, no `tool_call` input mutation) |
| Foreground → background | Command-text heuristics, or "arm the next call"; already-running commands cannot be detached ([K5],[K6]) | Live promotion after 120 s or on `ctrl+shift+b`, no restart ([P6]) | **Better**. kendex catches known monitor patterns at t=0 instead of t=120 s; that is its only edge |
| User `!` commands | Hooked (`user_bash`) ([K4]) | Not hooked ([P1] lists no `user_bash`) | **Lacks**, low value |
| Spawn | Pi reads pipes ([K12]) | fd straight to the log file ([P2]) | **Better**: no Pi-side backpressure, nothing lost if Pi stalls or dies |
| Group kill | SIGTERM, SIGKILL after 5 s, no confirmation the group vanished ([K13]) | SIGTERM, 3 s, SIGKILL, verifies, reports `stuck` ([P4]) | **Better** |
| Shutdown | SIGTERM+SIGKILL back to back ([K14]) | Full escalation with grace, waits for spawns in flight ([P5]) | **Better** |
| Crash of Pi | Children survive; re-adopted next session by pid + start time ([K17]) | Detached watcher kills the group and writes a GONE marker ([P3]) | **Different policy.** Not comparable; see § 5 |
| Orphan/pid reuse | Start-time identity check ([K17]) | Group-empty check by the watcher; kills only when Pi's pid is dead ([P3]) | Covers for its policy. Theoretical pgid-reuse window `unknown` |
| Log writing | 221-line batching/stall writer needed because Pi owns the pipe ([K19]) | Kernel writes the file ([P2]) | **Better** (nothing to copy) |
| Output reads | Tail only, no cursor ([K21]) | Cursor, `latest`, `filter`, Pi limits ([P7]) | **Better** |
| Bounded disk reads | Async, byte-bounded, cached, 4 slots ([K21]) | Range reads sync, but gz logs whole-file `gunzipSync` ([P12]) | **Lacks** for gz logs (§ 4 item 6) |
| ANSI/control stripping | None found ([K22]) | Pi's pipeline copied ([P7]) | **Better** |
| Log retention | 5 days, cwd-gone rule, same-uid checks ([K23]) | 7 days, owner pid, own filenames, symlink-safe, gzip, 100 MiB cap ([P9]) | **Better / covers**; cwd-gone rule is the only extra and is not needed (logs are small and gzip) |
| Runaway output | In-memory cap + drop markers ([K18],[K19]) | Kills the task at 100 MiB ([P9]) | **Better** (different, and bounded disk) |
| Completion wake | Exit wake, tail ≤2,000 chars, command ≤160 chars ([K11],[K24]) | Last 20 lines ≤4 KiB, **uncapped command** ([P8]) | **Lacks** the command cap |
| Output wakes | Pattern/transition/first-match, settle, budget ([K25],[K26]) | None ([P14]) | **Lacks** |
| Regex safety | 25 ms `vm` deadline ([K27]) | Bare `new RegExp` on model input ([P12]) | **Lacks** |
| Persistence/restore | Sidecar + session entries + replay ([K28],[K29]) | None by design: tasks belong to the session ([P5]) | **Different policy**; do not copy |
| Task-count bound | 50 finished, oldest dropped with log ([K23]) | Unbounded map ([P14]) | **Lacks**; `unknown` impact |
| UI | Widget, dashboard, message renderer ([K30],[K31]) | Footer count, hint widget, `ui.select` ([P10]) | **Lacks** by choice |
| Model text | Long appended system prompt; rules on stopping turn-scoped tasks ([K10]) | Tool-description text only ([P1]) | **Mixed**: pi-bg-bash has no "stop what you no longer need" rule |
| Config | ~30 settings ([K32]) | Test-only env vars ([P11]) | **Different**; keep minimal |
| Diagnostics | Opt-in log file ([K32]) | None; 27 bare `catch {` blocks in `src/` (`rg -c "catch \{" src`) | **Lacks** |
| Resource control | `systemd-run`/`nice` ([K16]) | None | **Lacks**, Linux-only, out of scope |

---

## 4. Ranked candidates to copy

Ranking weighs user-visible value against size and the risk of breaking
`AGENTS.md` rules (fixed tool names; README is the spec; tests pin behaviour so
a change needs a CHANGELOG entry; fake-time and real-process tests stay in
separate files).

### 1. One-shot "wake when this output appears" (`notifyPattern`, first match only)

- **What.** An optional parameter on `bash` (only meaningful with
  `background: true`), for example `notifyPattern`: when the task's output
  first matches, send *one* message (id, the matching line plus a few lines of
  context) and never again for that task. Exit message unchanged.
- **Evidence.** kendex's `notifyPattern` + `first-match-only`
  (`K:ext/registrations.ts:105-108`; `K:ext/wake-events.ts:290-293,320-325`;
  the scheduling and settle logic `K:ext/background-tasks.ts:498-590`); the
  contract text in `K:instructions.md:14-15`. pi-bg-bash's own gap: [P13].
- **Why it helps.** It makes the README's first-use example true (dev server
  "up") without the model looping on `bash_output` or `sleep`, which the bash
  description already forbids ([P1]). It also covers "wait for a log line".
- **Size.** About 80–150 lines: the poller already scans each running task's
  log incrementally for the exit marker (`P:src/registry.ts` poller,
  `scanFrom`); add a second scan position for the pattern, one `sendMessage`,
  tool parameter and text, README section, tests in the fake-process files.
- **Design choices to take from kendex.** Keep it *once* per task: that removes
  the need for kendex's transition hashes, `dedupeKey`, 20-wake/20 KB budget and
  exhaustion notice (`K:ext/wake-events.ts:19-65,260-318,571-619`), all of which
  were added because repeated output wakes grew the transcript ([K26]). Cap the
  inline text as kendex does (≤2,000 chars, [K24]). Match the *stripped* text
  ([P7]) so escape codes do not break a match.
- **Risk.** Adds a parameter and a second message kind to the README spec.
  Regex input needs the guard in candidate 3, or accept literal substrings only
  (`K:ext/format.ts:132-133` is kendex's substring fallback). Delivery mode:
  kendex uses `steer` for output wakes ([K24]); pi-bg-bash's exit message uses
  `followUp` ([P8]). What `steer` does to a turn in flight is `unknown` here
  (the installed Pi 1.0.0 `.d.ts` lists the modes without describing them,
  `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1215`);
  verify before choosing. A wake must not arrive after `bash_kill` (kendex voids
  pending wakes on stop, `K:ext/wake-events.ts:134-159`).

### 2. Cap the command echoed in the completion message

- **What.** Truncate `Command:` in `completionText` to a fixed length (kendex:
  160 characters in the message, 192 in manifests), ending with `…`.
- **Evidence.** kendex `WAKE_CONTENT_COMMAND_MAX_CHARS = 160` and
  `truncateForTranscript` (`K:ext/wake-events.ts:380-398,525-529`), motivated by
  "a 100KB heredoc command" growing the transcript (comment at
  `K:ext/wake-events.ts:370-379`). pi-bg-bash prints the full command
  (`P:src/notify.ts:84`) although `bash_tasks`/`/bg` already cut at 200
  (`P:src/notify.ts:73`).
- **Why it helps.** Agents often run multi-KB heredocs or scripts; the command
  is already in the transcript from the tool call, so the full echo only
  duplicates it.
- **Size.** About 3 lines, one test, one README sentence (README.md:127-133),
  CHANGELOG entry.
- **Risk.** Low. Existing tests use short commands and match
  `Command: <text>` exactly (`P:test/background.test.ts:61`,
  `P:test/poller.test.ts:190`, `P:test/foreground.test.ts:317`,
  `P:test/sanitize.test.ts:74`), so they still pass below the cap. The promoted
  foreground text may also echo the command; not checked (`unknown`).

### 3. Time-limit the model-supplied `filter` regex

- **What.** Run the `bash_output` filter over the page inside a `node:vm`
  script with a short `timeout` (kendex: 25 ms) and return a clear error if it
  trips, instead of freezing Pi on a catastrophic pattern.
- **Evidence.** kendex `parseOutputMatcher`
  (`K:ext/format.ts:77-134`), PR #3360 (bounded matcher), and the bug class in
  [P12] (`P:src/output.ts:33`: `filter.test(line)` per line, up to Pi's 50 KB
  page, on Pi's event loop).
- **Why it helps.** A model-written pattern like `(a+)+$` against a long line
  can block the whole UI; this is the only unbounded-CPU path in `bash_output`.
- **Size.** About 25–40 lines, one test with a pathological pattern, README
  line.
- **Risk.** `vm` timeouts are only proven under Node
  (`K:DEVELOPMENT.md:21`); whether Pi 1.0.0 runs extensions under Node in all
  distributions is `unknown`, so test on the real runtime and fall back to no
  guard if the timeout is not honoured. Apply the guard to the whole page in one
  script call, not per line, so the budget is per call. The same helper serves
  candidate 1 if regex patterns are allowed.

### 4. Opt-in diagnostics log

- **What.** `PI_BG_BASH_DEBUG=<file>` (or a boolean plus default path under the
  state directory): append timestamped lines where the code currently swallows
  an error (poller read failures, failed sends, gzip failures, watcher spawn
  failure, cleanup failures).
- **Evidence.** `K:ext/diagnostics.ts:5-28` and the invariant "Diagnostics
  never touch the terminal" (`K:DEVELOPMENT.md:15`); kendex used its log to
  distinguish stale Pi delivery from an extension bug (`K:DEVELOPMENT.md:27`).
  pi-bg-bash has 27 `catch {` lines in `src/` (`rg -c "catch \{" src`) and
  several documented fail-open paths (e.g. watcher failing to start,
  `P:src/launch.ts:188-198`) that are currently invisible.
- **Size.** About 20 lines plus a one-line call at each catch site, README
  entry.
- **Risk.** Low. New env var follows the `PI_BG_BASH_*` naming already
  reserved in `AGENTS.md`. Must never write to stdout/stderr (would corrupt the
  TUI); keep the file 0600 (kendex uses mkdir mode 0700, `K:ext/diagnostics.ts:22`).
  Tests need a temp path and must not touch the real state directory.

### 5. Model-facing rule: stop tasks you no longer need

- **What.** One sentence in the `bash` background text or the `bash_kill`
  description: kill a background task you started once its purpose is done
  (dev server, watcher) rather than leaving it until the session ends.
- **Evidence.** `K:instructions.md:22`: "Stop tasks you started for a
  turn-scoped purpose before finishing the turn." pi-bg-bash tasks live until
  session end ([P5]) and its text says nothing about cleaning up ([P1]).
- **Size.** One sentence, README sync (the README quotes the text's content at
  README.md:55-58), CHANGELOG.
- **Risk.** Wording: a blunt rule could make the model kill servers the user
  wants running. Keep it conditional ("that you started only for this check").
  Review against the `writing-for-agents` skill before merging. Whether the
  tests pin the description string: a search for two phrases in `test/` found
  nothing, full coverage not verified.

### 6. Bounded reads for finished (gzipped) logs — *derived from kendex's bounded-read work, not a kendex feature*

- **What.** Avoid `gunzipSync(readFileSync())` of the whole log per
  `bash_output` call (a 100 MiB log is the documented ceiling, [P12]): options
  are to cache the inflated buffer briefly, stream-inflate to the requested
  window, or skip gzip above a size.
- **Evidence.** kendex bounds every disk acquisition to `3*maxChars+1` bytes and
  caches by metadata (`K:ext/log-tail.ts:56-76`; PR #3360 table: 50 MB log, 30
  frames, 1,000,000 bytes read vs 36,001); kendex does *not* compress logs, so
  it has no direct equivalent.
- **Size.** Medium (gzip is not seekable); needs a design decision.
- **Risk.** Touches `logview.ts`, whose offsets keep read positions valid across
  the marker cut; real impact `unknown` (no measurement taken of the cost for a
  typical log).

### 7. Bound the number of finished tasks kept in the registry

- **What.** Keep at most N (kendex: 50) finished tasks in `bash_tasks`.
- **Evidence.** `K:ext/constants.ts:26`, `K:ext/background-tasks.ts:301-311`.
- **Risk / verdict.** Defer. Evicting a task makes `bash_output <id>` fail for it
  and changes README semantics ("Tasks belong to the session"); pi-bg-bash's task
  records are small. Only worth doing if a real long-session problem shows up
  ([P14]: `unknown`).

---

## 5. What pi-bg-bash should not copy

- **Cross-session persistence, restore, missed-exit replay, orphan watcher,
  pid-identity probes** ([K17],[K28],[K29]; about 900 lines across
  `persistence.ts`, `snapshot.ts`, `orphan-watcher.ts`, `probes.ts`,
  `tool-result-details.ts`). They exist because kendex tasks may outlive Pi and
  because Pi owns the output pipe. pi-bg-bash states the opposite rule ("Tasks
  belong to the session", [P5]) and kills survivors with the crash watcher
  ([P3]). Adopting this would reverse a documented design and need a new
  durable-state format (kendex's history: issues #177/#183/#184/#187 are all
  session-file growth bugs from exactly this state). The incident behind it
  (#15, #97) is a symptom of tasks stopping *without a wake*; pi-bg-bash's
  marker-or-pid-gone rule ("exit unknown", [P8], README.md:119-126) already
  ensures every task ends with a completion message while Pi is up.
- **The log writer and pipe back-pressure** ([K19]). A consequence of reading
  pipes in Pi. pi-bg-bash's fd redirect makes it unnecessary ([P2]).
- **Wake budget, transition hashes, `dedupeKey`, `notifyMode`** ([K25],[K26]).
  They manage *repeated* output wakes. If candidate 1 sends one wake per task,
  none of this is needed. If repeated wakes are ever wanted, treat kendex's
  #210 as the warning: the defaults must be bounded from the start.
- **Separate `bg_task`/`bg_status` tools with an `action` enum** ([K3]).
  `AGENTS.md` fixes pi-bg-bash's tool names, and the overlapping tools in
  kendex confuse the choice ("Use pid for log/stop" in one, `id` or `pid` in the
  other, `K:ext/registrations.ts:49,102,110`).
- **Rewriting the `bash` call's input to a `printf` acknowledgement** ([K4]).
  It starts a second copy of the command text as a task and runs an echo in its
  place, based on regexes over the command ([K5]); pi-bg-bash promotes the very
  process that is already running ([P6]). Do not add text heuristics; at most,
  mention in the tool description that `while true; do …; sleep` monitors
  should be `background: true` (the description already says so for waiting).
- **"Arm the next command" shortcut** ([K6]): strictly weaker than
  `ctrl+shift+b` promoting the running command ([P6]).
- **`appendSystem` + npm `postinstall` editing `APPEND_SYSTEM.md`** ([K10]).
  Intrusive (writes user and project files at install). pi-bg-bash carries its
  guidance in the tool description ([P1]) and has "no build step" and no
  install scripts (`P:README.md:34`).
- **Resource control via `systemd-run`/`nice`/`ionice`** ([K16]). Linux-only,
  while pi-bg-bash supports macOS ([P1]'s README requirement,
  `P:README.md:14`).
- **Dashboard, widget stack, glyph styles, `Symbol.for("kendex.*")` interop,
  `pi-session-bridge` broker events** ([K30],[K31]; `K:ext/constants.ts:9-10`;
  `K:ext/activity.ts`). Tied to kendex's other packages. The footer count
  ([P10]) is enough for the stated scope.
- **~30-setting configuration system with a 445-line reader and a settings
  cache** ([K32]). pi-bg-bash's fixed constants and test-only env vars ([P11])
  keep behaviour the README can specify exactly.
- **SIGTERM immediately followed by SIGKILL on shutdown** ([K14]). Worse than
  the current grace period ([P4]/[P5]).
- **Lane retention rules (cwd-gone deletion, 5 days)** ([K23]). pi-bg-bash's
  owner-pid, name-filter and symlink rules ([P9]) already protect live and
  foreign files; the cwd-gone rule fits kendex's worktree workflow, not a general
  extension.
- **A raw log path in the spawn result** ([K11]). Tempting (lets the model use
  its `read` tool), but pi-bg-bash logs are raw with markers and escape codes
  ([P7]); `bash_output` is the controlled view. Keep it out.

---

## 6. Unknowns

1. `unknown`: whether `node:vm` script timeouts are honoured in every runtime
   Pi 1.0.0 extensions run under (kendex only proves them under Node,
   `K:DEVELOPMENT.md:21`). Test before adopting candidate 3.
2. `unknown`: exact behaviour of `deliverAs: "steer"` versus `"followUp"` for a
   message arriving mid-turn in Pi 1.0.0; the type declarations list the modes
   without describing them. Needed to choose the delivery mode for candidate 1.
3. `unknown`: what happens to a kendex child that writes to its stdout pipe
   after Pi has died (SIGPIPE/EPIPE). No test or document in the package
   addresses it; kendex's README promises the task "rehydrates as running" and
   "polling" continues ([K17]) but does not say what the child's output does.
4. `unknown`: whether kendex's output-wake feature is used successfully in
   practice (no usage data); the evidence is the issue #210 bug report that the
   defaults grew transcripts, and the fixes.
5. `unknown`: the true root cause of kendex #97/#15 (tasks `stopped`, exit null).
   The issue lists hypotheses only; `detached: true` is the recorded hardening
   (`K:ext/background-tasks.ts:783-804`) and pi-bg-bash already does it ([P2]).
6. `unknown`: the cost of `gunzipSync` on a realistic finished log in pi-bg-bash
   (not measured), so candidate 6's priority is uncertain.
7. `unknown`: whether pi-bg-bash's tests pin the `bash` description text or
   `Command:` for a promoted foreground result beyond the files cited; only the
   `Command:` lines in four test files were checked.
8. `unknown`: whether a pgid reused within the watcher's one-second poll could
   make the watcher signal an unrelated group (`P:src/launch.ts:51`: it checks
   `kill -s 0 -- -grp` and Pi's pid only). Probability looks very low; kendex's
   start-time identity ([K17]) is the heavy fix and is not recommended without
   evidence.
9. `unknown`: whether kendex's `main` has changed after `45621a58`; this report
   pins that commit.

---

## 7. Method

- `gh api repos/vanillagreencom/kendex/commits/main` → SHA above;
  `gh api repos/vanillagreencom/kendex/git/trees/main?recursive=1` listed 27
  source modules, 80+ test files and fixtures under the package directory.
- `gh api repos/vanillagreencom/kendex/tarball/45621a58…` extracted the package
  directory; every `extensions/*.ts` module was read except `dashboard.ts`,
  `render.ts`, `glyphs.ts`, `stacked-widget.ts`, `package-config.ts`,
  `activity.ts`, `active-context.ts`, `coalesce.ts` and most of
  `resource-control.ts` (past line 140), which were read only for names and
  structure (UI, settings plumbing and resource control are not copy
  candidates). The test files were not read beyond
  `tests/spawn-hardening.test.ts` (which pins `detached: true`, `stdio:
  ["ignore","pipe","pipe"]`) and file names.
- Issues read: #15, #97, #210 (bodies); #97 has no comments, #15 has follow-up
  evidence. PR #3360's description was read for the measurement table. Other
  issues and PRs were taken from the titles of `gh search` results only.
- pi-bg-bash: `README.md`, `src/index.ts`, `notify.ts`, `kill.ts`,
  `sanitize.ts`, `launch.ts`, `logs.ts`, and the relevant parts of
  `registry.ts`, `logview.ts`, `output.ts` and `foreground.ts`. `git log`
  shows no earlier note on output wakes or persistence.
