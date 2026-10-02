# Contributing

Bug reports and pull requests are welcome. Report a security problem
privately, as [SECURITY.md](SECURITY.md) explains, not in an issue.

## Setup

Node 22.19 or later and pnpm, on macOS or Linux:

```sh
pnpm install
pnpm check   # lint, typecheck and tests, as CI runs them
```

The package has no runtime dependencies and no build step. The tests under
`test/` are not loaded by Pi and not published to npm. Run one test file with
`node --test test/kill.test.ts`. After changing `package.json` `files` or
adding a file under `src/`, run `node scripts/check-pack.mjs`: it checks the
file list `npm pack` would publish, then loads the packed bundle into Pi, so run
`pnpm install` first. To try a change in Pi, load your checkout:
`pi -e <path to this checkout>`.

## Tests

`pnpm test` runs two tiers. Fake time and real processes never meet in one
test file, and `--test-timeout` makes a call that never settles fail the run
instead of hanging it.

- **Behaviour tests** (`background`, `foreground`, `kill`, `logs`, `output`,
  `poller`, `sanitize`): the extension
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

## Pull requests

Every change reaches `main` through a pull request, and CI must pass before it
merges. Pull requests are squashed, so the title becomes the commit message:
say what changes for someone using pi-bg-bash.

- Add a user-visible change under `## [Unreleased]` in `CHANGELOG.md`. Leave
  `version` alone; releases set it.
- The tests pin current behaviour. If your change makes one fail on purpose,
  update the test and say so in the pull request and in `CHANGELOG.md`.
- The README describes the behaviour in detail. A change to what the tools,
  `/bg`, the shortcut or the logs do updates it in the same pull request.
