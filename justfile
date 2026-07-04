# Oblique — local-first image editor built around a modifier stack.
# Standard verbs: prep, install, run, check, build.

default:
    @just --list

[group('setup')]
prep:
    @echo "node:  $(node --version 2>/dev/null || echo MISSING)"
    @echo "pnpm:  $(pnpm --version 2>/dev/null || echo MISSING)"
    @echo "rustc: $(rustc --version 2>/dev/null || echo MISSING)"
    @echo "uv:    $(uv --version 2>/dev/null || echo MISSING)"

[group('setup')]
install:
    pnpm install
    uv sync --project sidecar
    pnpm exec lefthook install

[group('dev')]
run target="desktop":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{target}}" in
        desktop) pnpm tauri dev ;;
        web)     pnpm dev ;;
        *) echo "unknown target: {{target}}" >&2; exit 1 ;;
    esac

[group('quality')]
check:
    ./node_modules/.bin/tsc --noEmit
    ./node_modules/.bin/biome check .
    uv run --project sidecar ruff check .
    uv run --project sidecar ruff format --check .
    uv run --project sidecar pytest sidecar
    ./node_modules/.bin/vitest run
    ./node_modules/.bin/depcruise src
    node scripts/check-licenses.mjs

# Licence gate only (also part of `check`) — permissive allowlist, see script header.
[group('quality')]
licenses:
    node scripts/check-licenses.mjs

# Fix lint/format issues in place (hooks only ever check; this writes).
[group('quality')]
fmt:
    ./node_modules/.bin/biome check --write .
    uv run --project sidecar ruff check --fix .
    uv run --project sidecar ruff format .

[group('build')]
build:
    pnpm tauri build
