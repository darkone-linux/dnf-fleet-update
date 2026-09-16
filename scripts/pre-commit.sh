#!/usr/bin/env bash
#
# Pre-commit gate: `just check` (lint, typecheck, tests), the local mirror of CI.
#
# - checks the working tree, not the index: with `git add -p`, unstaged edits
#   count too;
# - refuses without the toolchain rather than skipping, `just commit` from the
#   workspace included: enter the dev shell first.
#
# Hook install: just hooks

set -euo pipefail

root=$(git rev-parse --show-toplevel)

refuse() {
  echo "pre-commit: refused, $*" >&2
  exit 1
}

for bin in bun just; do
  command -v "$bin" > /dev/null 2>&1 ||
    refuse "$bin not on PATH — enter the dev shell: nix develop $root"
done
[ -d "$root/node_modules" ] || refuse "dependencies missing — run: just install"

# Diagnostics come from `just check` itself; this line names the gate.
just --justfile "$root/Justfile" --working-directory "$root" check ||
  refuse "just check failed — formatting and safe fixes: just fix"
