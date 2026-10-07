# Oblique — local-first image editor built around a modifier stack.
# Standard verbs: prep, install, run, check, build.

default:
    @just --list

[group('setup')]
prep:
    @echo "node:  $(node --version 2>/dev/null || echo MISSING)"
    @echo "pnpm:  $(pnpm --version 2>/dev/null || echo MISSING)"
    @echo "rustc: $(rustc --version 2>/dev/null || echo MISSING) (also builds sidecar/kernels, see just kernels)"
    @echo "uv:    $(uv --version 2>/dev/null || echo MISSING)"

[group('setup')]
install:
    pnpm install
    uv sync --project sidecar
    pnpm exec lefthook install

# Force-rebuild the native kernels crate (sidecar/kernels) — normally `uv
# sync` above only rebuilds it when the Rust sources changed.
[group('build')]
kernels:
    uv sync --project sidecar --reinstall-package oblique-kernels

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
    # tauri-build wants bundle.resources to exist; on a clean clone (CI) the PyInstaller
    # output isn't there, and checking doesn't need it. An existing build is left alone.
    mkdir -p sidecar/dist/oblique-sidecar
    cargo test --manifest-path src-tauri/Cargo.toml --lib
    ./node_modules/.bin/depcruise src
    just licences

# Opt-in: every real project opens, saves (to memory) and reopens to the same tree. Takes
# colon-separated .oblique files and only reads them; needs `uv` for the op catalogue.
# `just coverage ~/Documents/v2-test.oblique`
[group('quality')]
coverage files:
    OBLIQUE_FILES="{{files}}" cargo test --manifest-path src-tauri/Cargo.toml --lib real_projects -- --ignored --nocapture

# Licence check (also part of `check`). Reads files only, no network. Re-resolve with
# `preset-compliance licences scan` after changing dependencies.
[group('quality')]
licences:
    preset-compliance licences check

# Fix lint/format issues in place (hooks only ever check; this writes).
[group('quality')]
fmt:
    ./node_modules/.bin/biome check --write .
    uv run --project sidecar ruff check --fix .
    uv run --project sidecar ruff format .

[group('build')]
build:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf sidecar/dist sidecar/build
    # --hidden-import: `ops/_kernels.py` (Epic 19) imports `oblique_kernels`
    # at module load, but nothing in main.py's import graph reaches
    # `_kernels` yet (story 2 wires a real kernel-backed op) — PyInstaller's
    # static analyser can't see it, so it's named explicitly.
    (cd sidecar && uv run pyinstaller --name oblique-sidecar --onedir --distpath dist --workpath build --specpath build --hidden-import oblique_kernels --noconfirm main.py)
    pnpm tauri build
    # tauri-bundler's ad-hoc signing doesn't reseal correctly once
    # bundle.resources adds a nested executable + dylib tree (sidecar-dist/)
    # — codesign --verify fails ("code has no resources but signature
    # indicates they must be present") even on the untouched build output.
    # That's what macOS shows to end users as "app is damaged" once
    # quarantined, not a Gatekeeper policy prompt. Re-sign deep + force to
    # reseal all resources under one valid (still ad-hoc, still
    # unnotarized) signature. Found 2026-07-10, Epic 14.
    product=$(node -p "require('./src-tauri/tauri.conf.json').productName")
    codesign --deep --force --sign - "src-tauri/target/release/bundle/macos/${product}.app"

# Friends build (Epic 14): zipped .app + README + THIRD-PARTY-LICENSES. Unsigned — see epic doc.
[group('build')]
package: build
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/generate-third-party-licenses.mjs
    product=$(node -p "require('./src-tauri/tauri.conf.json').productName")
    version=$(node -p "require('./package.json').version")
    outdir="dist-friends-build"
    rm -rf "$outdir"
    mkdir -p "$outdir"
    cp -R "src-tauri/target/release/bundle/macos/${product}.app" "$outdir/"
    sed "s/{{"{{"}}PRODUCT_NAME{{"}}"}}/${product}/g" packaging/friends-build-README.txt > "$outdir/README.txt"
    cp THIRD-PARTY-LICENSES "$outdir/"
    # ditto, not zip, for the .app itself — plain `zip` doesn't reliably
    # preserve the resource-fork/xattr metadata a code signature depends
    # on and is the classic cause of "app is damaged" after unzip. The two
    # plain text files have no such concerns, so a regular `zip -q` append
    # after is fine for those.
    (cd "$outdir" && \
        ditto -c -k --keepParent "${product}.app" "${product}-v${version}.zip" && \
        zip -q "${product}-v${version}.zip" README.txt THIRD-PARTY-LICENSES)
    echo "Packaged: $outdir/${product}-v${version}.zip"

# Version, changelog, commit and tag from the conventional commits since the last
# tag (knope.toml). Push stays by hand.
[group('build')]
release:
    knope release

# What `release` would do, without touching anything.
[group('build')]
release-preview:
    knope release --dry-run
