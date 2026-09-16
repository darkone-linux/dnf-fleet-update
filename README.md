# dnf-fleet-update

Fleet update and deployment tool for the
[Darkone NixOS Framework](https://github.com/darkone-linux/darkone-nixos-framework).

Generic over consumer projects: hosts, profiles and zones are read from the
consumer configuration, nothing is hardcoded.

Specification: `.specs/dnf/outils-de-deploiement-du-parc.md` in the consumer
workspace. It is the authority; this file only says how to run what exists.

## Status

Interface validated, engine not written. The only runnable entry point replays
recorded event streams through the real interface.

```bash
nix develop            # or: nix-shell
bun install
just mock nominal      # nominal, offline, build-failure, ai-repair, abort
```

The replay blocks on every question and waits for an answer, so the interactive
path is exercised rather than faked.

## Keys

| Key | Action |
|---|---|
| `q` | quit; leaves the log view when in it |
| `⇥` | move focus between feed and host table |
| `↑↓` | scroll the focused pane; change host in the log view |
| `↵` | selected host → its logs; confirm a question button |
| `←→` | pick a question button |
| `alt+↓` `alt+↑` | expand / collapse the AI answer |
| `a` | free-text question to the AI |
| `^C` | abort (twice: stop now) |
| `Esc` | close help, AI input, log view; cancel a question |
| `?` | help |

## Verifying the interface

Never read the interface out of a pty dump: unchanged cells are not repainted,
neighbouring text looks glued, and colours are invisible. Use the capture
harness, which renders into a test buffer with no terminal at all.

```bash
just capture nominal              # exact cells of the final frame
just capture nominal 11500        # ... as it stood at t=11.5 s
just capture-colors ai-repair     # one line per span: fg, bg, attributes
```

Flags: `--at`, `--cols`, `--rows`, `--view=logs`, `--selected=N`, `--spans`.
Spinners freeze under `FLEET_CAPTURE` so a frame can reach visual idle.

## Layout

- `src/model/` — event contract (`events.ts`), state fold (`state.ts`), theme.
  Pure: no I/O, no interface, no timers.
- `src/engine/` — engine side. Today `replay.ts` only.
- `src/ui/` — OpenTUI components. Presentation only, fed from `RunState`.
- `src/testing/` — deterministic frame capture.
- `mock/scenarios/` — recorded event streams (JSONL), one per scenario.

The interface never calls the engine: both meet on the event stream of
`src/model/events.ts`, the same one that will feed `state.json` and `--no-ui`.

## Checks

```bash
just check   # typecheck
just test    # folds every scenario and asserts the end state
```

## Runtime

Bun (OpenTUI reaches its Zig core through Bun's FFI). Node needs >= 26.4 with
`--experimental-ffi` and is not supported here.
