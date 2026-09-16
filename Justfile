set shell := ["bash", "-euo", "pipefail", "-c"]

# Default -> just --list
_default:
    @just --list

# Install dependencies
install:
    bun install

# Replay a mock scenario in the real interface
mock scenario="nominal":
    bun run src/main.tsx {{scenario}}

# List available scenarios
scenarios:
    bun run src/main.tsx --list

# Type check
check:
    bun x tsc --noEmit
