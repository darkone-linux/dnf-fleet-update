# dnf-fleet-update

Fleet update and deployment tool for the
[Darkone NixOS Framework](https://github.com/darkone-linux/darkone-nixos-framework).

Generic over consumer projects: hosts, profiles and zones are read from the
consumer configuration, nothing is hardcoded.

Specification: `.specs/dnf/outils-de-deploiement-du-parc.md` in the consumer
workspace.

## Status

Mockup. The interface is being iterated before the engine is written, so the
only runnable entry point replays recorded event streams.

```bash
nix-shell          # or: nix develop
bun install
just mock nominal  # scenarios: nominal, offline, build-failure, ai-repair, abort
```

`q` quits, `⇥` switches focus, `↵` opens host logs, `a` opens the AI dialog,
`^C` aborts, `?` shows help.

## Layout

- `src/model/` — event contract, state fold, theme. No I/O, no interface.
- `src/engine/` — engine side. Today a scenario replayer only.
- `src/ui/` — OpenTUI React interface.
- `mock/scenarios/` — recorded event streams (JSONL), one per scenario.

The interface never calls the engine: it consumes the event stream of
`src/model/events.ts`, the same one that feeds `state.json` and `--no-ui`.

## Runtime

Bun (OpenTUI reaches its Zig core through Bun's FFI). Node needs >= 26.4 with
`--experimental-ffi` and is not supported here.
