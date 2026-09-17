# AGENTS.md

Telegraph style. Rules for `dnf-fleet-update` (`fleet-update`), fleet update
tool of the Darkone NixOS Framework. The spec
(`.specs/dnf/outils-de-deploiement-du-parc.md`, consumer workspace) owns
behaviour; this file owns code policy and routing.

## Overview

- TypeScript (strict) on Bun; interface on OpenTUI (`@opentui/react`).
- Interface validated on recorded scenarios. Engine (native Nix commands, no
  colmena) not written: contracts only (`src/engine/ports.ts`).
- Published by tag (GitHub release); packaged by the framework
  (`dnf/pkgs/fleet-update/package.nix`), not here: § Framework contract.

## Rules

- 95% confidence before edits; else ask follow-ups.
- Behaviour comes from the spec. Missing or ambiguous → ask; never invent an
  option, a default, a threshold, an exit code or an event.
- Prefer robust, simple, maintained over clever. Built-ins first: `Bun.spawn`,
  `node:util` `parseArgs`, `bun:test`.
- Verify an API against the shipped `.d.ts` in `node_modules` before use:
  OpenTUI prop types already differed from its published docs.
- English: code, comments, interface strings, commits. French: spec and
  framework documentation only.
- After editing: `just fix`, then `just check` green before committing. Never
  `--no-verify`; never weaken a rule, a type or a test to get green.
- Lint suppression: local `biome-ignore <rule>: <reason>`, reason mandatory.
- Commit message: one line, 80 chars max, english, `<type>(<scope>): <message>`
  (ex: `feat(engine): plan waves by profile`).
  - Never include references to the AI used (Claude session, etc.)!
  - Closed type list, enforced by the `commit-msg` hook and CI, consumed by
    `git-cliff`: `feat fix perf refactor docs test build ci chore security revert`.
    A scope is never a type: `feat(ui): …`, never `ui(feed): …`.
  - Scope: the layer or area touched — `model`, `engine`, `adapters`, `ai`,
    `cli`, `ui`, `output`, `testing`, `deps`, `ci`, `release`.
  - Breaking change: `!` after the scope, subject naming the broken surface
    (option, exit code, event field, `var/deployments/` layout, `just` recipe).
    No `BREAKING CHANGE:` footer (single-line rule). Drives the MINOR bump in 0.x.
    Ex: `feat(model)!: rename host.output phase to step`.
  - Changelog sections: `feat`→Added, `fix`→Fixed, `security`→Security,
    `perf`/`refactor`/`revert`→Changed, `docs`→Documentation, a `drop`/`remove`
    subject→Removed. `chore ci test build` are not published.

### Comments

The reader is SCANNING code, not reading an essay. A comment that has to be
read twice has failed, however accurate it is.

- Explain **why**, not what: intent, constraint, non-obvious decision.
- Never restate what the code or its types already express.
- **Length budget: 3 lines. 6 is the hard ceiling** for one block. Past that,
  the explanation belongs in the spec — leave a pointer (`spec § Verrou`).
- **One idea per comment.**
- **Telegraph style: clauses, not sentences.** No narration, no retelling of
  the incident behind the code.
- Naming a mechanism beats describing it: `O_CLOEXEC`, `systemd-run --wait`,
  `noUncheckedIndexedAccess`.
- Blank line before every comment. Exceptions: file header, first line of a
  block (the formatter removes that blank line).
- File header: what the module is, then its role or constraint.
- JSDoc (`/** */`) on exports whose contract the name and type do not carry:
  unit, range, when it rejects.

```ts
// NO — narrative
// Commands used to go through a shell, but a host named `a;rm -rf /` would
// then have run arbitrary code, so we now pass an argv array instead.

// YES
// argv, no shell: a host name cannot inject.
```

## TypeScript

- `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`,
  `noImplicitOverride`: never loosened.
- No `any`. Outside data (nix JSON, `state.json`, scenario lines) is `unknown`
  until validated; `as` only on validated data; `!` only after a check the
  compiler cannot follow.
- `import type` for types (`verbatimModuleSyntax`); relative imports keep
  their `.ts` / `.tsx` extension.
- Discriminated unions on `kind`; exhaustive `switch`
  (`useExhaustiveSwitchCases`). Constants: `as const` object + derived type
  (`ExitCode`), no `enum`.
- Expected failures are data — non-zero exit, host `failed`, `log` event —
  not exceptions. Throw for programmer errors and "cannot continue" only.
- Async: no floating promise (`noFloatingPromises`); every wait and command
  takes an `AbortSignal`; every external command has a timeout.
- External commands: `argv` arrays through `CommandRunner`, never a shell string.
- No `console.*` outside `src/main.tsx`, `src/cli/`, `src/output/`,
  `src/testing/` and tests: the engine speaks in events.
- No module-level side effect outside entry points (`main.tsx`,
  `testing/capture.tsx`).
- Functions and plain data first; classes for stateful port implementations.

## Architecture

Layers. `biome.jsonc` overrides fail the lint on a forbidden import.

| Path | Role | May import |
|---|---|---|
| `src/model/` | contract: `events.ts` (stream, `RunSource`, `RunControl`), `params.ts` (resolved options), `state.ts` (interface fold), `persist.ts` (`state.json` fold), `transitions.ts`, `exit-codes.ts`, `theme.ts` | `model/` only; no Node/Bun API |
| `src/engine/` | orchestration: `ports.ts` (side-effect contracts), `fleet.ts` (consumer data schemas), `query.ts` (`--on`), `waves.ts` (waves, current zone), `nix-output.ts` (eval and build log parsers), `replay.ts` (scenario source) | model |
| `src/engine/commands/` | argv builders (`CommandSpec`): workspace (git, flake, `just`), build (`nix-eval-jobs`, `nix build`), hosts (ssh, sudo as `nix`, activation, rollback) | model, engine |
| `src/engine/steps/` | *planned* — one module per step, receives `EngineContext` | model, ports |
| `src/adapters/` | *planned* — real ports: process (`CommandRunner`), flock, store (`var/deployments/`), Matrix | model, ports |
| `src/ai/` | *planned* — providers (Claude Agent SDK, opencode), guarded tools | model, engine |
| `src/cli/` | `options.ts` (argv → run parameters, validation: exit `2`, `--resume` rules), `help.ts` | model, engine |
| `src/ui/` | TUI: `App.tsx` (screen, keys, views), `panels.tsx` (components); presentation only | model |
| `src/output/` | *planned* — `--no-ui` text output | model |
| `src/testing/` | capture harness, port fakes | anything |
| `src/main.tsx` | composition root: binds a run source to a consumer | anything |
| `tests/` | integration tests; fixtures in `tests/fixtures/` | anything |
| `mock/scenarios/` | recorded streams (`.jsonl`) | — |

- Planned directories appear with their first file; no empty placeholders.
- Pure decisions (`--on` selection, waves, host transitions): plain functions
  without ports, unit-tested; steps only orchestrate them.
- New side effect → port in `ports.ts`, fake in `testing/fakes.ts`, then adapter.

## Event stream

- Only coupling between the engine and its consumers: TUI, `--no-ui`,
  `state.json` (fold). The interface never imports the engine; `main.tsx`
  binds a `RunSource`.
- Adding or changing a field: fold, scenarios and tests in the same commit.
- Unknown `kind` ignored by the fold: a newer engine never breaks an older
  interface. Removing or renaming a field is breaking (`!`).
- `t`: milliseconds since run start, from `Clock`; never `Date.now()` in the engine.

## Tests

- Runner: `bun test` (`bun:test`), nothing else.
- Unit tests colocated: `src/**/<name>.test.ts(x)`, next to the module.
- Integration tests: `tests/` — entry point spawned as a process, scripts,
  steps on fakes.
- Required: pure code ships with its tests; a bug fix ships with a regression
  test that failed first.
- Engine: `fakeContext()` (`src/testing/fakes.ts`) — commands scripted by argv
  prefix, manual clock, recorded events, scripted answers. Unscripted command
  or unanswered question = failure.
- Never in tests: real nix, ssh, network, remote host, wall-clock sleep.
  Adapters: temp dirs and local programs only.
- Scenarios are contract fixtures, folded by `src/model/state.test.ts`. New
  event kind → a scenario exercising it.
- Assert outcomes (state, events, exit code), not internal calls — unless the
  command is the contract (argv of `nix copy`).
- Coverage: `just coverage`; `src/testing/` and `tests/` excluded.

### Verifying the interface

Never judge the interface from a pty dump: OpenTUI repaints only changed cells
and moves the cursor for the rest, so stripping ANSI glues neighbouring text and
loses every colour. Three false alarms came from exactly that.

- `just capture <scenario> [at]` — exact cells.
- `just capture-colors <scenario> [at]` — one line per span with `fg`, `bg` and
  attributes (`a1` = bold).
- Emoji occupy two cells for one code point, so `captureSpans` splits colour
  runs oddly around them. Put a band on a host whose glyph is the one-column
  spinner before concluding anything is wrong.
- Refactor touching `src/ui/`: compare captures of every scenario before/after.

## Dependencies

- Bun only: `bun add` / `bun remove` / `bun update`. `bun.lock` committed, never
  hand-edited; CI installs with `--frozen-lockfile`. No npm, yarn or pnpm lockfile.
- New dependency: maintained, typed, needed; built-ins first. Ask before adding
  a runtime dependency.
- `0.x` packages pinned exactly (OpenTUI breaks in minors).
- Biome pinned exactly: its formatting changes between patches. On Linux the
  Justfile selects its static musl binary (`BIOME_BINARY`): NixOS cannot start
  the glibc one.
- `zod`: validation of outside JSON (generator output, nix JSON, `state.json`).
- Planned, added with its first importing code: `@anthropic-ai/claude-agent-sdk` (AI v1).
- `just audit` in CI: a high-severity advisory blocks merge and release.

## Hooks and CI

- `just install`: dependencies, then hooks (symlinks in `.git/hooks`).
  - `commit-msg` → `scripts/check-commit-msg.sh`: mirror of dnf's gate, body
    identical; drift fails `tests/commit-msg.test.ts` in the workspace.
  - `pre-commit` → `scripts/pre-commit.sh`: `just check`. Refuses without `bun`
    or `just` on PATH: enter `nix develop`, also before `just commit` from the
    workspace.
- CI (`.github/workflows/ci.yml`, push to `main` and PRs): commit messages,
  lint, typecheck, tests with coverage, audit. Toolchain from `nix develop`.
- Every CI step is a `just` recipe: change the recipe, not the workflow.

## Framework contract

What `dnf/` builds around this repo. A change on either side moves the other
in the same release train.

| Surface | DNF side | Holds here |
|---|---|---|
| Launch | package: `bun run <out>/lib/fleet-update/src/main.tsx`; `just fleet-update`: same file from sources (codev) | entry stays `src/main.tsx`; no `bun build --compile` |
| Packaged files | `package.json`, `tsconfig.json`, `src/`, `mock/`, production `node_modules` | a runtime read elsewhere → package first; `tests/cli.test.ts` runs outside the repo |
| Workspace | recipe `cd` and unit `WorkingDirectory` = consumer root | workspace = cwd; codev = `dnf/.git` present |
| Fleet defaults | generator: `network.fleetUpdate.{deploymentOrder,criticalProfiles}` in `var/generated/network.nix`, only when declared, syntax checked | option > `network.fleetUpdate` > built-in default |
| Unattended run | module: `fleet-update --no-ui <timer.extraArgs>`, `User` = project owner, `SuccessExitStatus=4`, `KillMode=mixed`, `TimeoutStartSec`, `restartIfChanged = false` | SIGTERM → children stopped, run `interrupted`; codes of `exit-codes.ts` |
| Programs | package `PATH` suffix: `git`, `nix-eval-jobs`, `ssh`; host: `nix`; unit: `just`, `statix`, `deadnix`, `nixfmt`, `treefmt`, `dnf-generator`, `cargo`; `/run/wrappers/bin`: `sudo`, `ping` | argv names resolved from `PATH`, never a store path |
| Deploy identity | key `~nix/.ssh/id_ed25519`, readable by `nix` only | ssh and `nix copy` through `sudo -u nix -H`, like `just apply` |
| Toplevel | colmena and `nixosConfigurations` evaluate to the same path | build `nixosConfigurations.<host>.config.system.build.toplevel` |
| `var/deployments/` | consumer `.gitignore`: `/var/*`, except `generated/` and `security/**/*.pub` | run state never dirties the tree check |
| Version | `versionCheckHook` once `--version` exists; tags `vX.Y.Z` pinned by the train | `--version` prints `package.json` version, exit `0` |

## Release

- Version: `package.json` only, written by `just bump`.
- SemVer. `0.x`: MINOR = breaking (options, exit codes, event stream,
  `var/deployments/` layout); PATCH = everything else.
- Shared with the ecosystem, co-development workspace required:
  `dnf/just/scripts/bump.sh` and `cliff.toml`.
- `just changelog`: preview, writes nothing.
- `just bump [auto|patch|minor|major|X.Y.Z]`: version, CHANGELOG entry,
  `chore(release): vX.Y.Z` commit, annotated tag. No push.
- `just release [level]`: `just ci`, bump, push branch and tag.
- Workspace train (`just release` at its root, `dnf/just/codev/release.just`):
  gates `ci` + `audit`, releases this repo when it moved since its last tag,
  then pins the tag in the framework package (`just pkg-update fleet-update <version>`).
- Tag `v*` → `release.yml`: guards (tag = `package.json`, CHANGELOG entry), CI
  replay, GitHub release with the CHANGELOG section as notes.
- Released CHANGELOG sections are history, never rewritten. Hand-written notes
  go under `## [Unreleased]`.

## Protected files

- `bun.lock`: bun commands only.
- `package.json` `version`, released `CHANGELOG.md` sections: `just bump` only.
- `scripts/check-commit-msg.sh` body: change `dnf/scripts/check-commit-msg.sh`
  first, then mirror.
- `mock/scenarios/*.jsonl`: contract fixtures, edited with fold and tests.
- Other workspace repositories (`dnf/`, `doc/`, `src/*`): their own AGENTS.md
  and `.git`.

## Commands

| Recipe | Does |
|---|---|
| `just install` | dependencies and git hooks |
| `just check` | lint, typecheck, tests: the pre-commit gate |
| `just fix` | formatting, safe lint fixes, import order |
| `just lint` / `just typecheck` / `just test [filter]` | one gate each |
| `just coverage` | tests with coverage report |
| `just audit` | dependency advisories, high and above |
| `just ci` | what CI runs, from a frozen install |
| `just mock <scenario>` | replay in the real interface |
| `just capture` / `just capture-colors` | exact frame / colour spans |
| `just changelog` / `just bump` / `just release` | § Release |
