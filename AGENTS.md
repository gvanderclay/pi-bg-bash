# pi-bg-bash

A Pi extension that replaces the model's `bash` tool with Pi's own `bash` plus
a `background` flag, moves long foreground commands to the background, and
adds the `bash_output`, `bash_tasks` and `bash_kill` tools, the `/bg` command
and the `ctrl+shift+b` shortcut.

## Layout

- The extension is the `.ts` files in `src/`. `src/index.ts` is the entry Pi
  loads and registers the tools; `registry.ts` holds the tasks and the poller,
  `launch.ts` the wrapper and the crash watcher, `foreground.ts` foreground
  calls and promotion, `bg.ts` the `/bg` command, `debug.ts` the opt-in debug log, `kill.ts` the group kill, `port.ts` the only contact
  with real processes, `logs.ts` and `logview.ts` the logs, `output.ts`
  `bash_output`, `notify.ts` the completion message, and `sanitize.ts` the
  output stripping.
- Tests and their helper (`harness.ts`) are in `test/`. Nothing under `test/`
  is published; `scripts/check-pack.mjs` enforces that.

## Checks

- `pnpm check` runs lint (`biome ci .`), typecheck (`tsc -p .`) and the
  tests. Run it before every commit; CI runs the same on Node 22.19 and 24,
  on Linux, with a fresh `HOME` and no `PI_CODING_AGENT_DIR`.
- A single file: `node --test test/kill.test.ts`.
- `node scripts/check-pack.mjs` after changing `package.json` `files` or adding
  a file under `src/`. Every `.ts` file under `src/` must be packed. It also
  packs the bundle and loads it into the project's Pi, so run `pnpm install`
  first.
- `biome.json` relaxes some rules for the files that predate this repository
  (one override per file). New files get the full rules; do not add a file to
  an override to get past a rule.

## Changes

- Never commit to `main`: a ruleset refuses pushes there. Work on a branch,
  open a pull request with `gh pr create`, and merge with
  `gh pr merge --squash --auto`; it merges once the `check` and `pack` jobs
  pass. The pull request title becomes the commit message.
- Repository settings and rulesets live in `.github/repo-settings.json`.
  Change them there, in a pull request, then apply them with
  `node scripts/repo-settings.mjs` (`--dry-run` first); never in GitHub's UI.
- Fill in `.github/pull_request_template.md`. `CONTRIBUTING.md` is the
  human-facing copy of these rules; keep the two in step.
- Add each user-visible change under `## [Unreleased]` in `CHANGELOG.md` as
  it lands. Never edit `version` or tag by hand; see Releases.

## Releases

- Release with `pnpm release patch` (or `minor`, `major`) on an up-to-date
  `main`: it bumps the version, moves the CHANGELOG entries and opens a
  release pull request set to auto-merge. It refuses when `[Unreleased]` is
  empty. Once that merges, `release.yml` sees an untagged version on `main`,
  checks, tags, publishes to npm by trusted publishing, and makes the GitHub
  release.

## Rules

- The tests pin current behaviour. A change that makes one fail changes
  behaviour: update the test only when the change is deliberate, and say so
  in the pull request and in `CHANGELOG.md`.
- The README is the behaviour's specification. Change it with the behaviour.
- Fake time and real processes never meet in one test file: behaviour tests
  run over the fake process port on mock timers, `test/contract.test.ts` over
  the real port on real time. Tests swap the port through `test/harness.ts`
  (`fakeProcesses`, `restoreProcesses`); a test that needs one call to fail
  may wrap the current port with `setProcessPort`, as `test/logs.test.ts`
  does, and its `afterEach` must call `restoreProcesses`.
- The tools, `/bg`, `ctrl+shift+b`, the `PI_BG_BASH_*` variables and the log
  path `$XDG_STATE_HOME/pi-bg/` keep their names; the package is `pi-bg-bash`.
