# Changelog

All notable changes to dnf-fleet-update are documented here.  
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versioning: [SemVer](https://semver.org/). While in `0.x`, **MINOR carries the
breaking changes** — command-line options, exit codes, the event stream
(`src/model/events.ts`) and the layout of `var/deployments/`.

## [Unreleased]

## [0.3.1] - 2026-09-19

### Added

- **engine**: --resume picks up the last unfinished deployment
- **ui**: Footer drops the segments a narrow window cannot hold
- **ui**: Chronometer on the Update row, magenta, top right
- **ui**: Running step drops its band, the spinner marks it
- **engine**: Take a busy lock from its holder, then offer its run
- **engine**: Incidents message for critical hosts and hosts in test
- **engine**: Send the report to the Matrix alert rooms
- **engine**: Readable report header, UTC start date and options
- **engine**: Name the deployed hosts in the report summary

### Fixed

- **icon**: Revert icon updated
- **engine**: Bound the Matrix send by the matrix timeout
- **alerts**: Render the report markdown as Matrix HTML

### Changed

- **engine**: Send the report through just send-msg

## [0.3.0] - 2026-09-18

### Added

- **engine**: Switch tested hosts at once, --skip-test for waves
- **cli**: --skip-switch stops the run after the test

### Fixed

- **engine**: Nix copy sends unsigned paths, like just apply
- **ui**: Wave numbering, active columns, eval warnings

## [0.2.0] - 2026-09-17

### ⚠ Breaking

- **model**: Separate host presence, add error and reverted states
- **cli**: Entry point runs the engine, scenario replay leaves it

### Added

- **fleet-update**: Interface mockup
- **fleet-update**: Opencode-style interface rev 2
- **fleet-update**: Opencode-style interface rev 3
- **fleet-update**: Opencode-style interface rev 4
- **fleet-update**: Opencode-style interface rev 5
- **fleet-update**: Interface alpha validée + spec
- **model**: Legal host state transitions, scenarios made to follow them
- **model**: State.json fold with per-host status
- **engine**: Fleet data schemas for hosts, zones and fleet defaults
- **engine**: --on host query, deployment waves and current zone
- **cli**: Option parsing, validation, resolution order and resume rules
- **engine**: Nix-eval-jobs and internal-json output parsers
- **engine**: Argv builders for workspace, build and host commands
- **adapters**: Process runner killing the whole group, and system clock
- **engine**: Run store, run lock and local host ports, with fakes
- **adapters**: Run lock by flock(2) on a file opened with O_CLOEXEC
- **adapters**: Deployments store with atomic state.json, and local host
- **engine**: Stream recorder: events, state.json on change, host logs
- **engine**: Update and select steps on a shared run context
- **engine**: Build step with evaluation, presence pings, failed host decisions
- **engine**: Test and switch waves, activation result, lost hosts, rollback
- **engine**: Run orchestration: lock, prerequisites, report, exit codes
- **model**: Run end writes the report to the feed and closes a pending question
- **ui**: Abort, ping and quit go through the run control
- **output**: --no-ui text output, the feed without colours
- **engine**: An abort request is logged before commands are killed
- **adapters**: Live event channel between the engine and its consumer
- **engine**: Forced rollback keeps its result, read after a dropped session
- **engine**: Failed activation, host reachable: revert, keep, stop, rollback
- **engine**: Evaluation error trace written to the host build log
- **ui**: Host logs reachable from the table while a question is pending
- **ui**: Unknown presence shown until the first ping answers
- **ui**: S stops now and stays open; abort now quits once the run ended
- **cli**: Run directory printed on exit, once it exists
- **model**: Build-only rules out test and switch, failures not decided
- **ui**: Omitted step name as dim as its cross
- **engine**: Known error signatures said in plain language

### Fixed

- **engine**: Abort now also ends the read of network.nix, exit 5
- **engine**: Report.md steps table no longer lists the report step running
- **engine**: No build confirmation once an abort after the step is requested
- **engine**: One stop on a failed evaluation, rollback offered only when useful
- **engine**: Nix error reason is the last error line of its trace
- **engine**: Nothing built stops once; build failures decided by shared reason
- **model**: Step cut by an abort now closed as aborted, cut hosts interrupted
- **engine**: Commands as nix run in the login shell of nix, for its PATH
- **engine**: Consumer flake updated before dnf, every input refreshed

### Changed

- **engine**: Every command spec carries its deadline and kill grace
- **model**: Built-in defaults in params, network.nix parsed on its own
- **testing**: Scenario replay moves to its own development entry point

### Documentation

- **readme**: Rewrite - alpha
- **release**: Framework packaging contract and release train
- **testing**: Whole runs on the simulated fleet in AGENTS.md

[Unreleased]: https://github.com/darkone-linux/dnf-fleet-update/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/darkone-linux/dnf-fleet-update/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/darkone-linux/dnf-fleet-update/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/darkone-linux/dnf-fleet-update/releases/tag/v0.2.0
