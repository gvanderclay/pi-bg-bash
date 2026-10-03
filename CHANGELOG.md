# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gvanderclay/pi-bg-bash/releases/tag/v0.1.0
