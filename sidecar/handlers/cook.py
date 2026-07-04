"""`cook` handler — decode payload, fold the modifier stack, re-encode.

Per the protocol (guidance/projects/oblique/design/architecture.md Section
"Python sidecar protocol"): payload is RGBA8, non-premultiplied, sRGB,
row-major, no padding. `np.frombuffer` gives a read-only view, so we
`.copy()` once up front to get a writable array; individual ops never
mutate their input anyway (each returns a fresh array), so this copy only
protects the original payload bytes object.

Index 0 of the `modifiers` array applies first (left-to-right fold). The
client already filters `enabled: false` before sending, so every modifier
present here runs — nothing is skipped. Unknown op name -> `ok: false`
naming the op, no partial results (validated up front, before folding).
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from ops import OPS


def handle_cook(header: dict[str, Any], payload: bytes) -> tuple[dict[str, Any], bytes]:
    request_id = header.get("id")
    width = header.get("width")
    height = header.get("height")
    modifiers = header.get("modifiers", [])

    if (
        not isinstance(width, int)
        or not isinstance(height, int)
        or width <= 0
        or height <= 0
    ):
        return (
            {
                "id": request_id,
                "ok": False,
                "error": "cook requires positive integer width and height",
            },
            b"",
        )

    # Validate every modifier's op name up front — no partial results.
    for modifier in modifiers:
        op_name = modifier.get("type")
        if op_name not in OPS:
            return {
                "id": request_id,
                "ok": False,
                "error": f"unknown op '{op_name}'",
            }, b""

    expected_bytes = width * height * 4
    if len(payload) != expected_bytes:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": (
                    f"expected {expected_bytes} payload bytes for "
                    f"{width}x{height} RGBA8, got {len(payload)}"
                ),
            },
            b"",
        )

    img = np.frombuffer(payload, dtype=np.uint8).copy().reshape(height, width, 4)

    # Per-op wall time in ms, returned in the header for client-side debug
    # logging. perf_counter reads cost ~ns against ops that cost ms, so the
    # measurement can't skew what it measures.
    timings_ms: list[dict[str, Any]] = []
    for modifier in modifiers:
        entry = OPS[modifier["type"]]
        started = time.perf_counter()
        img = entry.fn(img, modifier.get("params", {}))
        timings_ms.append(
            {
                "type": modifier["type"],
                "ms": round((time.perf_counter() - started) * 1000, 2),
            }
        )

    result = np.ascontiguousarray(img, dtype=np.uint8).tobytes()
    return {
        "id": request_id,
        "ok": True,
        "width": width,
        "height": height,
        "timings_ms": timings_ms,
    }, result
