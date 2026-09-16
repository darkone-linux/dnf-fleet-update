# DNF Fleet Updater

[![Status: alpha](https://img.shields.io/badge/status-alpha-e0b341)](#status)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![OpenTUI](https://img.shields.io/badge/UI-OpenTUI-b191f2)](https://github.com/sst/opentui)
[![NixOS Unstable](https://img.shields.io/badge/NixOS-unstable-5277C3?logo=nixos&logoColor=white)](https://nixos.org/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

- Framework: [Darkone NixOS Framework](https://github.com/darkone-linux/darkone-nixos-framework)
- Siblings: [Boilerplate](https://github.com/darkone-linux/dnf-boilerplate) • [Example](https://github.com/darkone-linux/dnf-example) • [Generator](https://github.com/darkone-linux/dnf-generator) • [Documentation](https://github.com/darkone-linux/dnf-doc)

**Update a whole NixOS fleet in one command, and watch it happen.**

`fleet-update` upgrades the flakes, builds every host once, tests the new
configuration wave by wave — the hosts your network depends on first — then
switches everything that passed. It works on any [DNF](https://github.com/darkone-linux/darkone-nixos-framework) consumer project: hosts,
profiles and zones come from your configuration, nothing is hardcoded.

![DNF Fleet Updater: a failed nginx activation analysed by the AI, which offers to restart the service](assets/dfu-screenshot-01.png)

## Highlights

- 🌊 **Deployment in waves.** `hcs` first, then the gateway and hosts of the zone
  you stand in, then the other zones, grouped by profile. A broken
  configuration stops before it reaches the rest of the fleet.
- ❄️ **Native Nix.** One `nix-eval-jobs` evaluation, one build per
  host, then `nix copy` of the exact store path that was built — no
  re-evaluation, no drift if the repository changes mid-run.
- 🛟 **Safe activation.** Runs under `systemd-run` so it survives a dropped SSH
  session; an automatic rollback restores the previous system if the host stays
  unreachable.
- 🔁 **Resumable.** Every event is written to `var/deployments/`; after an
  interruption, `--resume` continues with the hosts left.
- 🤖 **AI on call, on a leash.** AI (local or remote) analyses failures from deterministic
  evidence (`systemctl status`, `journalctl`, build logs) and can propose a
  repair. It only acts through the tool's own guarded actions (no free shell,
  no free SSH) and every action is logged and confirmed.
- 🖥️ **A terminal interface built for reading.** A feed of what happened,
  panels for what needs attention, and the state of every step and host at a
  glance. Open any host's logs without losing the overview.
- ⏰ **Unattended too.** `--no-ui` produces plain text for a systemd timer,
  with a Matrix report to the alert rooms and meaningful exit codes.
- 🔒 **One run at a time.** A kernel `flock` that cannot be orphaned.

## Status

**Alpha.** The interface is validated and runs today on recorded event streams;
the engine behind it is being written. The options below are the specified
contract, not yet implemented.

```bash
nix develop            # or: nix-shell
just install
just mock ai-repair    # nominal, offline, build-failure, ai-repair, abort
```

The replay stops on every question and waits for your answer: the interactive
path is exercised, not simulated.

## How it works

| Step | What happens |
|---|---|
| **Update** | `nix flake update` of `dnf/` (codev) and of the consumer, `just clean`, one commit per repository |
| **Select** | hosts, profiles and zones read from `var/generated/`, filtered by `--on`; current zone detected from the local IP |
| **Probe** | parallel pings, offline hosts set aside |
| **Build** | every selected host, online or not, on the deployment machine |
| **Test** | `switch-to-configuration test` wave by wave; the next wave starts once every host is OK or excluded |
| **Switch** | every host validated in test |
| **Report** | final state, AI summary if enabled, Matrix message if `--send-report` |

A git tree that is not clean, or a lock already held, stops the run before it
starts.

## Usage

```
fleet-update [options]
```

### Selection and order

| Option | Default | Description |
|---|---|---|
| `--on <query>` | all hosts | names, globs, `@tag` or `+profile`, e.g. `"gfx,hcs,gw-*"` or `"@zone-ag,+gateway"` |
| `--deployment-order <profiles>` | `hcs:gateway:server:[others]:laptop` | one wave per profile; `[others]` = profiles not listed |
| `--critical-profiles <profiles>` | `hcs:gateway:server` | failures on these hosts also go to the incidents room |
| `--no-current-zone-before` | | waves by profile across all zones, without testing the current zone first |

### Update

| Option | Default | Description |
|---|---|---|
| `--no-dnf-flake` | | skip `nix flake update` of `dnf/` (codev only) |
| `--no-consumer-flake` | | skip `nix flake update` of the consumer |
| `--dnf-message <msg>` | `chore(update): regular flake upgrade` | commit message in `dnf/` (codev only) |
| `--consumer-message <msg>` | `chore(update): full fleet` | commit message in the consumer (`chore(update): <--on>` for a partial run) |

### Flow

| Option | Description |
|---|---|
| `--build-only` | stop after the build (interactive: ask whether to go on) |
| `--resume` | resume the last unfinished deployment |
| `--non-interactive` | no confirmation at key steps; guards only |

### Output

| Option | Description |
|---|---|
| `--no-ui` | plain text output, forces `--non-interactive` |
| `--send-report` | send the report summary to the Matrix alert rooms |

### AI

| Option | Default | Description |
|---|---|---|
| `--ai-model <tool>[:<model>][@<effort>]` | `claude:opus@high` | e.g. `claude:opus@max`, `opencode:ollama/qwen3:32b` |
| `--ai-analysis none\|passive\|active` | `none` | analysis depth and AI-enriched report |
| `--ai-error-action none\|analysis\|repair` | `analysis` | what the AI may do when something fails |

The level sets the tools the AI can use, never more:

| Level | Tools |
|---|---|
| `passive` | deployment state, build and activation logs, failed units and their journal |
| `active` / `analysis` | + read the code (consumer, `dnf/`), host journals and units, read-only |
| `repair` | + act on a service, edit the code, validate, commit, retry, exclude a host, give up after 3 attempts |

### Execution

| Option | Default | Description |
|---|---|---|
| `--max-parallel <n>` | `10` | hosts copied and activated at once within a wave |
| `--rollback-timeout <seconds>` | `600` | automatic rollback of a host left unreachable after activation (`0` = off) |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | done |
| `1` | stopped on error |
| `2` | invalid options |
| `3` | done, report not sent |
| `4` | lock already held |
| `5` | aborted by the user |

## Use cases

**Routine update of the whole fleet**, from the admin workstation:

```bash
fleet-update
```

**Target a few hosts** — hosts, globs, tags and profiles combine:

```bash
fleet-update --on "gfx,fd-*"
fleet-update --on "@zone-ag,+gateway"
```

**Build first, deploy later** — check that everything compiles without
touching a host:

```bash
fleet-update --build-only
```

**Resume after an interruption** (`^C`, lost connection, host fixed by hand).
Options that shape the run (`--on`, `--ai-*`, `--max-parallel`...) may be
overridden:

```bash
fleet-update --resume --on "nlt"
```

**Let the AI repair**, with a confirmation before each action:

```bash
fleet-update --ai-analysis active --ai-error-action repair
```

**Unattended nightly run** — what the `darkone.admin.fleet-update` module
schedules with a systemd timer:

```bash
fleet-update --no-ui --send-report
```

Exit code `4` (a run already in progress) is not an error for the service.

## Interface

Read it left to right: the feed tells what happened, the panels carry what
needs attention, the right column gives the overall state.

| Key | Action |
|---|---|
| `q` | quit; leaves the log view when in it |
| `⇥` | move focus between feed and host table |
| `↑↓` | scroll the focused pane; change host in the log view |
| `↵` | selected host → its logs; confirm a question button |
| `←→` | pick a question button |
| `alt+↓` `alt+↑` | expand / collapse the AI answer |
| `a` | free-text question to the AI |
| `^C` | abort: `after wave`, `now` or `cancel` (twice: `now`) |
| `Esc` | close help, AI input, log view; cancel a question |
| `?` | help |

Host states: ☁️ pending · 🌥️ built · 🌤️ tested · ☀️ deployed · 🌦️ failed
(service) · 🌧️ failed (other) · 💤 offline. Excluded hosts are hidden and
counted in the table header.

Needs a terminal of at least 100×24, and a font covering *Symbols for Legacy
Computing* for the panel rules. `--no-ui` covers everything else.

## Development

```bash
just mock <scenario>            # replay a scenario in the real interface
just capture <scenario> [ms]    # exact cells of a frame, no terminal
just capture-colors <scenario>  # one line per span: fg, bg, attributes
just check                      # typecheck
just test                       # folds every scenario, asserts the end state
```

Never judge the interface from a pty dump: unchanged cells are not repainted,
neighbouring text looks glued and colours are lost. Use the capture harness.

| Path | Role |
|---|---|
| `src/model/` | event contract (`events.ts`), state fold (`state.ts`), theme — pure, no I/O |
| `src/engine/` | engine side; today the scenario player |
| `src/ui/` | OpenTUI components, presentation only |
| `src/testing/` | deterministic frame capture |
| `mock/scenarios/` | recorded event streams (JSONL) |

The interface never calls the engine: both meet on the event stream of
`src/model/events.ts`, which also feeds `state.json` and `--no-ui`.

Runtime: Bun — OpenTUI reaches its Zig core through Bun's FFI.

## License

[GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0).
