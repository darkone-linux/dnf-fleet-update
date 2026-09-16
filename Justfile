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

# Print the exact frame of a scenario at a given time, without a terminal
capture scenario="nominal" at="999999":
    bun run src/testing/capture.tsx {{scenario}} --at={{at}}

# Same, but one line per span with its colours (fg/bg/attributes)
capture-colors scenario="nominal" at="999999":
    bun run src/testing/capture.tsx {{scenario}} --at={{at}} --spans

# Type check
check:
    bun x tsc --noEmit

# Unit tests
test:
    bun test
