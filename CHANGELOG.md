# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Pi's screen no longer flickers once a running background task's `bash`
  row has scrolled off screen. The row redrew every second to count the
  runtime, and Pi repaints the whole screen and scrollback whenever a line
  above the screen changes. The row now shows when the task started
  (`Running since 2:14:13 PM`) and redraws once, when the task ends. The
  test that pinned the per-second redraw changes with it.

## [0.4.0] - 2026-10-19

### Added

- A `bash` row that started a background task, or was moved to one, shows the
  task's runtime (`Running 1m 5s`, updated every second) and then how it
  ended, instead of Pi's `Took 0.0s`.

### Changed

- The result of a call that goes on as a task, and the `bash_output`
  description, now tell the model to end its turn rather than sleep or poll.
- A call moved to the background with `ctrl+shift+b` tells the model that
  the user did it on purpose and not to rerun the command or sleep in its
  place, instead of `Command still running after N s`.
- A task's completion message reaches a busy agent when its current turn
  ends (`deliverAs: "steer"`) instead of waiting until the agent stops
  (`followUp`). Before, every task that ended during a run arrived after the
  agent's final answer, one turn each, so that answer was no longer the last
  message. The tests that pin the delivery mode change with it.

## [0.3.0] - 2026-10-19

### Added

- `bash_output`, `bash_tasks` and `bash_kill` declare an output schema and
  return matching structured results, so a codemode script can poll and kill a
  task as objects instead of parsing text. The text the model reads is
  unchanged.
- All four tools set the `readOnlyHint`, `destructiveHint`, `idempotentHint`
  and `openWorldHint` annotations.

## [0.2.2] - 2026-10-19

### Fixed

- In codemode scripts, a `bash` call that leaves the command running as a task
  (`background: true`, `waitFor`, the 120 s move, `ctrl+shift+b`) resolves to
  the declared object, with the new optional `task_id`, instead of a string.
  `exit_code` is now optional in the tool's output schema: it is absent while
  the command runs.

## [0.2.1] - 2026-10-07

### Changed

- `/bg` lists running tasks first, then the most recently started. The `/bg`
  listing test in `test/kill.test.ts` now expects that order.
- `q` closes the `/bg` task list, as esc does.

## [0.2.0] - 2026-10-03

### Added

- `bash` takes `waitFor`, a text to wait for in a foreground command's output.
  When it appears the call returns the output so far and the command keeps
  running as a background task (even after `sleep`); an explicit `timeout` then
  becomes the task's deadline. A call that ends without the text says it never
  appeared. `test/background.test.ts` now expects `waitFor` among the
  parameters.
- `PI_BG_BASH_DEBUG=1` turns on a diagnostic log, `debug.log` in the state
  directory (`$XDG_STATE_HOME/pi-bg/`): one JSON object per line with the
  errors the extension otherwise swallows, and task start and exit, kills,
  promotions and deadlines. At session start it is rotated above 5 MiB into
  five gzipped generations. Without the variable nothing is written.

### Changed

- `/bg` in the terminal UI is a task list where enter shows the selected task's
  output (scrollable, following new output while at the bottom, without moving
  `bash_output`'s read position) and `x` kills the task after a confirmation
  that shows the command on one line; esc closes it. The list and the output
  refresh every second. A kill no longer happens
  on a plain pick, in RPC mode too: it asks first. The `/bg` tests in
  `test/kill.test.ts` and `test/lifetime.test.ts` are updated for the new keys
  and the confirmation.
- The completion message shows the command on one line (newlines as ` ⏎ `, cut
  to 200 characters), as `bash_tasks` and `/bg` do.
- `@earendil-works/pi-tui` is a new peer dependency, provided by Pi.

## [0.1.2] - 2026-10-02

### Changed

- The `bash` description says when to set `background: true` (a command
  expected to outlast a minute or two), drops the `until … sleep` example, and
  takes the 120 s promotion and `bash_kill`'s 3 s grace from the code. The
  "do not sleep or poll" line is now only in the description, not repeated in
  the start and promotion results. The tests in `test/background.test.ts` and
  `test/foreground.test.ts` that pinned the old wording are updated, as is the
  byte-capped tail test in `test/output.test.ts`, whose label now says it was cut.
- The completion message says when its output was cut to the last 20 lines or
  4 KiB, and names `bash_output <id>` for the rest.
- `bash_output` and `bash_kill` name `bash_tasks` when the task id is unknown.

## [0.1.1] - 2026-10-02

### Changed

- The `bash` description tells the model to wait for something to finish (a
  CI run, a deploy, a server coming up) with a command that blocks until it
  does, such as `gh run watch <run-id> --exit-status`, run with
  `background: true`, instead of `sleep N` followed by a check.

## [0.1.0] - 2026-10-02

The first public release. Before this repository the package lived in its
author's dotfiles; the changes below are against that copy.

### Added

- Published to npm as `pi-bg-bash`.
- MIT license and package metadata, including `engines` (Node 22.19 or later).
- CI on Node 22.19 and 24: lint, typecheck, tests, and a check of the
  published file list that also loads the packed bundle into Pi.

### Changed

- The sources moved to `src/`; the `pi` manifest loads `./src/index.ts`.

### Fixed

- On Linux, where `sh` is dash, a command that killed itself no longer adds
  dash's `Killed` job notice to its output.
- On Linux, `bash_kill` and `/bg` on a task that had just exited no longer
  count the exiting wrapper as a process the task left running.
- Two behaviour tests that waited a fixed number of fake-time ticks for real
  file I/O now wait for the I/O itself, so they pass on a loaded machine.

[Unreleased]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gvanderclay/pi-bg-bash/releases/tag/v0.1.0
