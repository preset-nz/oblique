#!/usr/bin/env python3
"""Licence gate for the Python sidecar (locked decision 12; policy in
guidance/projects/oblique/design/licensing.md). Fails `just check` when any
installed sidecar package (runtime or dev) carries a licence outside the
permissive allowlist — mirrors scripts/check-licenses.mjs for npm.

Allowlist changes happen here AND in the policy doc, same commit.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parent.parent / "sidecar"

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
}

# pip-licenses reports a mix of SPDX ids (from PEP 639 License-Expression)
# and human-readable classifier names — normalise the ones this tree has
# actually produced. Anything unmapped fails closed (treated as a
# violation) rather than silently passing.
NORMALISE = {
    "MIT License": "MIT",
    "BSD License": "BSD-3-Clause",
    "Apache Software License": "Apache-2.0",
    "GNU General Public License v2 (GPLv2)": "GPL-2.0",
    "Python Software Foundation License": "Python-2.0",
}

# Reviewed per-package exceptions (policy doc §Recorded exceptions has the
# reasoning). Key = package name, value = the note shown when listing.
EXCEPTIONS = {
    # GPL-2.0+, but PyInstaller's own COPYING.txt grants an explicit
    # Bootloader Exception permitting embedding the compiled bootloader in
    # proprietary distributions without restriction. Reviewed 2026-07-10.
    "pyinstaller": "GPL-2.0 w/ bootloader exception — see COPYING.txt",
    # Build-time hook definitions consumed by PyInstaller's analyser; not
    # itself embedded in the frozen output. Same review, 2026-07-10.
    "pyinstaller-hooks-contrib": "GPL-2.0 (build-time hooks only, not embedded)",
}


def licence_allowed(expr: str) -> bool:
    stripped = expr.replace("(", " ").replace(")", " ").strip()
    if re.search(r"\bOR\b", stripped):
        return any(
            licence_allowed(part.strip()) for part in re.split(r"\bOR\b", stripped)
        )
    if re.search(r"\bAND\b", stripped):
        return all(
            licence_allowed(part.strip()) for part in re.split(r"\bAND\b", stripped)
        )
    normalised = NORMALISE.get(stripped, stripped)
    return normalised in ALLOWED


def main() -> int:
    raw = subprocess.run(
        ["uv", "run", "pip-licenses", "--format=json"],
        cwd=SIDECAR_DIR,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    packages = json.loads(raw)

    violations = []
    for pkg in packages:
        name = pkg["Name"]
        if name in EXCEPTIONS:
            continue
        # pip-licenses joins multiple classifier-derived licences with "; ".
        parts = [p.strip() for p in pkg["License"].split(";")]
        if not all(licence_allowed(p) for p in parts):
            violations.append(f"  {name} — {pkg['License']}")

    if violations:
        print(
            "Licence gate: disallowed licences in the Python sidecar tree:",
            file=sys.stderr,
        )
        print("\n".join(violations), file=sys.stderr)
        print(
            "\nPolicy: guidance/projects/oblique/design/licensing.md (permissive-only).",
            file=sys.stderr,
        )
        return 1

    print(f"licence gate: {len(packages)} Python packages, all permissive ✔")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
