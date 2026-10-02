# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/gvanderclay/pi-bg-bash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gvanderclay/pi-bg-bash/releases/tag/v0.1.0
