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

    # Optional per-modifier masks (selection-to-mask.md): single-channel
    # planes appended after the image payload in modifier order, described
    # by header entries {modifierIndex, mask_bytes}. Absent array = the
    # pre-mask frame format, byte for byte.
    mask_entries = header.get("masks", [])
    mask_plane_bytes = width * height
    for entry in mask_entries:
        index = entry.get("modifierIndex")
        size = entry.get("mask_bytes")
        if not isinstance(index, int) or not 0 <= index < len(modifiers):
            return {
                "id": request_id,
                "ok": False,
                "error": f"mask modifierIndex {index!r} out of range",
            }, b""
        if size != mask_plane_bytes:
            return {
                "id": request_id,
                "ok": False,
                "error": (
                    f"mask for modifier {index} must be {mask_plane_bytes} bytes "
                    f"({width}x{height} single-channel), got {size!r}"
                ),
            }, b""

    image_bytes = width * height * 4
    expected_bytes = image_bytes + mask_plane_bytes * len(mask_entries)
    if len(payload) != expected_bytes:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": (
                    f"expected {expected_bytes} payload bytes for "
                    f"{width}x{height} RGBA8 + {len(mask_entries)} mask(s), "
                    f"got {len(payload)}"
                ),
            },
            b"",
        )

    img = (
        np.frombuffer(payload[:image_bytes], dtype=np.uint8)
        .copy()
        .reshape(height, width, 4)
    )

    # Slice each mask plane back out, keyed by the modifier it wraps.
    masks_by_index: dict[int, np.ndarray] = {}
    offset = image_bytes
    for entry in mask_entries:
        plane = np.frombuffer(
            payload[offset : offset + mask_plane_bytes], dtype=np.uint8
        )
        masks_by_index[entry["modifierIndex"]] = plane.reshape(height, width)
        offset += mask_plane_bytes

    # Per-op wall time in ms, returned in the header for client-side debug
    # logging. perf_counter reads cost ~ns against ops that cost ms, so the
    # measurement can't skew what it measures.
    timings_ms: list[dict[str, Any]] = []
    for index, modifier in enumerate(modifiers):
        entry = OPS[modifier["type"]]
        started = time.perf_counter()
        mask = masks_by_index.get(index)
        if mask is None:
            img = entry.fn(img, modifier.get("params", {}))
        else:
            # Masked modifier: blend the op's output against the buffer that
            # ENTERED it — mask*out + (1-mask)*before, all four channels.
            # Ops return fresh arrays and never mutate their input (module
            # docstring above), so holding `before` needs no copy. The blend
            # wraps the op call; the op itself stays pure and mask-unaware,
            # and the run is not split (selection-to-mask.md §Decision).
            before = img
            out = entry.fn(img, modifier.get("params", {}))
            weight = (mask.astype(np.float32) / 255.0)[..., None]
            blended = weight * out.astype(np.float32) + (1.0 - weight) * before.astype(
                np.float32
            )
            img = np.clip(np.rint(blended), 0, 255).astype(np.uint8)
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
