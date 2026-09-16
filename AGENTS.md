# AGENTS.md

Telegraph style. Local rules for `dnf-fleet-update`. The specification
(`.specs/dnf/outils-de-deploiement-du-parc.md` in the consumer workspace) is the
authority on behaviour; this file carries only what is specific to this repo.

## Overview

- TypeScript on Bun, OpenTUI (`@opentui/react`) for the interface.
- Interface validated against recorded scenarios. The engine — native Nix
  commands, no colmena — is not written yet.

## Rules

- 95% confidence before edits; else ask follow-ups.
- Code and interface strings in **English**. French belongs to the consumer spec
  and to the framework documentation.
- Comments: why not what, 3 lines, 6 max, clauses not sentences, blank line
  before every comment block.
- Commit message: one line, 80 chars max, `<type>(<scope>): <message>`, closed
  type list (`feat fix perf refactor docs test build ci chore security revert`).
  Never reference the AI used.
- Prefer robust and maintained over clever. Verify an API against the shipped
  `.d.ts` in `node_modules` before using it — this project has already been
  bitten by prop types that differ from the published docs.

## Layout

- `src/model/` — `events.ts` (contract), `state.ts` (fold), `theme.ts`
  (palette, glyphs, spinners). Pure: no I/O, no interface, no timers.
- `src/engine/` — engine side. Today `replay.ts`, the scenario player.
- `src/ui/` — `App.tsx` (screen, keys, views) and `panels.tsx` (components).
  Presentation only: everything comes from `RunState`.
- `src/testing/capture.tsx` — deterministic frame capture, no terminal.
- `mock/scenarios/*.jsonl` — recorded event streams.

## Boundary

The interface never calls the engine. Both sides meet on the event stream of
`src/model/events.ts`, which will also feed `state.json` and `--no-ui`. Adding a
field there means updating the fold, the scenarios and the tests together.

## Verifying the interface

Never judge the interface from a pty dump: OpenTUI repaints only changed cells
and moves the cursor for the rest, so stripping ANSI glues neighbouring text and
loses every colour. Three false alarms came from exactly that.

- `just capture <scenario> [at]` — exact cells.
- `just capture-colors <scenario> [at]` — one line per span with `fg`, `bg` and
  attributes (`a1` = bold).
- Emoji occupy two cells for one code point, so `captureSpans` splits colour
  runs oddly around them. Put a band on a host whose glyph is the one-column
  spinner before concluding anything is wrong.

## Commands

- `just mock <scenario>` — replay in the real interface.
- `just capture` / `just capture-colors` — see above.
- `just check` — typecheck. `just test` — unit tests.
