set shell := ["bash", "-euo", "pipefail", "-c"]

# Static musl build on every Linux: NixOS cannot start the glibc one, and CI
# then lints with the very same binary.
export BIOME_BINARY := if os() == "linux" { "@biomejs/cli-linux-" + replace(replace(arch(), "x86_64", "x64"), "aarch64", "arm64") + "-musl/biome" } else { "" }

# Shared with dnf-generator and dnf-doc: one changelog format, one commit
# vocabulary. Needs the co-development workspace (`../../dnf`).
dnfScripts := justfile_directory() / "../../dnf/just/scripts"

# Default -> just --list
_default:
    @just --list

#------------------------------------------------------------------------------
# Setup
#------------------------------------------------------------------------------

# Install dependencies and git hooks
[group('setup')]
install:
    bun install
    just hooks

# Install the commit-msg and pre-commit hooks (symlinks into .git/hooks)
[group('setup')]
hooks:
    #!/usr/bin/env bash
    set -euo pipefail
    hooks=$(git rev-parse --path-format=absolute --git-path hooks)
    mkdir -p "$hooks"
    ln -sfn "$(realpath --relative-to="$hooks" scripts/check-commit-msg.sh)" "$hooks/commit-msg"
    ln -sfn "$(realpath --relative-to="$hooks" scripts/pre-commit.sh)" "$hooks/pre-commit"
    ls -l "$hooks/commit-msg" "$hooks/pre-commit"

#------------------------------------------------------------------------------
# Interface mockup
#------------------------------------------------------------------------------

# Replay a mock scenario in the real interface
[group('mock')]
mock scenario="nominal":
    bun run src/testing/mock.tsx {{ scenario }}

# List available scenarios
[group('mock')]
scenarios:
    bun run src/testing/mock.tsx --list

# Print the exact frame of a scenario at a given time, without a terminal
[group('mock')]
capture scenario="nominal" at="999999":
    bun run src/testing/capture.tsx {{ scenario }} --at={{ at }}

# Same, but one line per span with its colours (fg/bg/attributes)
[group('mock')]
capture-colors scenario="nominal" at="999999":
    bun run src/testing/capture.tsx {{ scenario }} --at={{ at }} --spans

#------------------------------------------------------------------------------
# Quality
#------------------------------------------------------------------------------

# Full local gate: lint, typecheck, tests (pre-commit hook, mirrors CI)
[group('quality')]
check: lint typecheck test

# Format, lint and import order, read-only (CI adds --reporter=github)
[group('quality')]
lint *args:
    bun x biome check --error-on-warnings {{ args }} .

# Apply formatting, safe lint fixes and import order
[group('quality')]
fix:
    bun x biome check --write .

# Type check
[group('quality')]
typecheck:
    bun x tsc --noEmit

# Unit and integration tests (filter: just test <path or name>)
[group('quality')]
test *args:
    bun test {{ args }}

# Tests with a coverage report (text + coverage/lcov.info)
[group('quality')]
coverage:
    bun test --coverage

# Known vulnerabilities in the dependency tree, high severity and above
[group('quality')]
audit:
    bun audit --audit-level=high

# Exactly what CI runs, from a clean install
[group('quality')]
ci:
    bun install --frozen-lockfile
    just lint
    just typecheck
    just coverage

#------------------------------------------------------------------------------
# Release
#------------------------------------------------------------------------------

# Preview the entry the next release would carry — writes nothing
[group('release')]
changelog: _workspace
    @git-cliff --config {{ dnfScripts }}/cliff.toml --unreleased --bump 2>/dev/null

# Version, CHANGELOG entry, commit and tag, no push: just bump [auto|patch|minor|major|X.Y.Z]
[group('release')]
bump level="auto" *args: _workspace
    bash {{ dnfScripts }}/bump.sh \
        --config {{ dnfScripts }}/cliff.toml --level {{ level }} {{ args }}

# Gate, bump, push branch and tag; GitHub publishes the release (release.yml)
[group('release')]
release level="auto": _workspace
    #!/usr/bin/env bash
    set -euo pipefail

    # Same gate as CI: a red release.yml after the tag is pushed means a
    # published tag without a release.
    just ci
    just bump {{ level }}
    version="v$(jq -r .version package.json)"
    git push
    git push origin "$version"
    echo "Pushed $version — release.yml builds the GitHub release."

# Current version, last tag, revision
[group('release')]
version:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "version .... $(jq -r .version package.json)"
    echo "last tag ... $(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || echo none)"
    echo "revision ... $(git rev-parse --short HEAD)$(git diff --quiet || echo ' (dirty)')"

_workspace:
    #!/usr/bin/env bash
    if [ ! -f "{{ dnfScripts }}/bump.sh" ]; then
        echo "Release recipes need the DNF co-development workspace: {{ dnfScripts }} not found." >&2
        exit 1
    fi
