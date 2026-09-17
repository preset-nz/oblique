#!/usr/bin/env python3
"""Licence gate for `sidecar/kernels` (Epic 19 story 1; policy in
guidance/projects/oblique/design/licensing.md). Fails `just check` when any
resolved Rust package in the kernels crate's dependency graph carries a
licence outside the permissive allowlist — same shape as
check_python_licenses.py, same allowlist, `cargo metadata` in place of
`pip-licenses`.

Allowlist changes happen here AND in the policy doc, same commit.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
KERNELS_MANIFEST = REPO_ROOT / "sidecar" / "kernels" / "Cargo.toml"

ALLOWED = {
    "MIT",
    "MIT-0",
    "ISC",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "0BSD",
    "Zlib",
    "Unlicense",
    "CC0-1.0",
    "BlueOak-1.0.0",
    "Python-2.0",
    "MIT-CMU",
    "HPND",
    "OFL-1.1",  # fonts only
    "CC-BY-4.0",  # data/docs assets only
    "Unicode-3.0",  # Unicode data tables (unicode-ident via syn); permissive, OSI-approved 2024
}

# Reviewed per-crate exceptions (policy doc §Recorded exceptions has the
# reasoning; additions need that doc edited in the same commit). Key = crate
# name, value = the note shown when listing. Empty here — see the story's
# shipped note for the one crate (unicode-ident, "Unicode-3.0") that needs a
# decision from Georg before it can be added.
EXCEPTIONS: dict[str, str] = {}


def _split_top_level(expr: str, operator: str) -> list[str] | None:
    """Split `expr` on `operator` (a whole word) only where it appears
    outside any parenthesis nesting — `(MIT OR Apache-2.0) AND Unicode-3.0`
    must split on the outer `AND`, not the parenthesised `OR`. Returns
    `None` (not a two-element-plus list) when the operator doesn't occur
    at depth 0, so callers can fall through to the next-lower-precedence
    operator instead of mis-splitting inside a group.
    """
    depth = 0
    parts: list[str] = []
    last = 0
    i = 0
    n = len(expr)
    while i < n:
        ch = expr[i]
        if ch == "(":
            depth += 1
            i += 1
            continue
        if ch == ")":
            depth -= 1
            i += 1
            continue
        if depth == 0 and expr[i:].startswith(operator):
            before = expr[i - 1] if i > 0 else " "
            after_idx = i + len(operator)
            after = expr[after_idx] if after_idx < n else " "
            if not before.isalnum() and not after.isalnum():
                parts.append(expr[last:i])
                last = after_idx
                i = after_idx
                continue
        i += 1
    parts.append(expr[last:])
    return parts if len(parts) > 1 else None


def licence_allowed(expr: str) -> bool:
    stripped = expr.strip()
    # A fully-parenthesised expression, e.g. "(MIT OR Apache-2.0)" — strip
    # the redundant outer grouping and re-evaluate.
    if stripped.startswith("(") and stripped.endswith(")"):
        depth = 0
        wraps_whole = True
        for i, ch in enumerate(stripped):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and i != len(stripped) - 1:
                    wraps_whole = False
                    break
        if wraps_whole:
            return licence_allowed(stripped[1:-1])

    # Precedence (SPDX license-expression spec): WITH > AND > OR, so OR is
    # the outermost (lowest-precedence, split-first) operator — but never
    # split inside an explicit `(...)` grouping (see `_split_top_level`).
    or_parts = _split_top_level(stripped, "OR")
    if or_parts is None:
        # Pre-2018 crates sometimes use `/` where SPDX means `OR` (e.g.
        # "MIT/Apache-2.0"); no crate here mixes `/` with real grouping,
        # so a plain split is safe.
        if "/" in stripped and "(" not in stripped:
            or_parts = stripped.split("/")
    if or_parts is not None:
        return any(licence_allowed(part.strip()) for part in or_parts)

    and_parts = _split_top_level(stripped, "AND")
    if and_parts is not None:
        return all(licence_allowed(part.strip()) for part in and_parts)

    with_parts = _split_top_level(stripped, "WITH")
    if with_parts is not None:
        # SPDX licence-plus-exception: the exception only *grants*
        # additional permission over the base licence, never restricts it,
        # so `X WITH Y` is allowed iff `X` is allowed.
        return licence_allowed(with_parts[0].strip())

    return stripped in ALLOWED


def main() -> int:
    raw = subprocess.run(
        [
            "cargo",
            "metadata",
            "--format-version",
            "1",
            "--manifest-path",
            str(KERNELS_MANIFEST),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    metadata = json.loads(raw)
    packages = metadata["packages"]

    violations = []
    for pkg in packages:
        name = pkg["name"]
        if name in EXCEPTIONS:
            continue
        licence = pkg.get("license")
        if not licence:
            violations.append(f"  {name} {pkg['version']} — no licence field")
            continue
        if not licence_allowed(licence):
            violations.append(f"  {name} {pkg['version']} — {licence}")

    if violations:
        print(
            "Licence gate: disallowed licences in sidecar/kernels' Rust dependency tree:",
            file=sys.stderr,
        )
        print("\n".join(violations), file=sys.stderr)
        print(
            "\nPolicy: guidance/projects/oblique/design/licensing.md (permissive-only).",
            file=sys.stderr,
        )
        return 1

    print(f"licence gate (rust): {len(packages)} crates, all permissive ✔")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
