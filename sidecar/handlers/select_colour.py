"""`select_colour` handler — the magic wand (Epic 17 story 2b,
colour-range-select.md). No model, no weights: `ml/colour.py`'s
`select_colour` is pure NumPy, so this handler's only real job is the wire
format and combining multiple seeds.

Per the protocol: payload is RGBA8 `width*height*4` bytes (the node's cooked
buffer, same convention as `segment`). Response payload is a single-channel
u8 mask (0/255) at the same size — same shape as `segment`'s; `polygons` are
closed contours in the same pixel space, holes KEPT (`trace_mask(...,
keep_holes=True)`, unlike `segment`'s v1) — a wand on a background needs to
select around an object it's touching, not swallow it.

This module owns all header parsing and payload byte-slicing; `ml/colour.py`
never sees a request header or raw payload bytes, only NumPy arrays and
already-unpacked keyword params, so it stays protocol-free (same rule
`handlers/segment.py` documents for `ml/`).

**Multiple seeds** (the request's `seeds` array, deviating from the story
doc's single `seed` field per the orchestrator's override — see this epic's
README for the note): each seed is resolved as its OWN full
`select_colour(...)` call (threshold -> contiguous filter -> expand ->
min_island, `ml/colour.py`'s fixed order, in full, per seed) using the
request's shared `params`; positive-label results are OR-ed together,
negative-label results are then subtracted from that union. This is NOT the
same as running `select_colour` once per polarity and combining before
`expand`/`min_island` — `expand` and `min_island` are not linear under
union for erode/min-island (dilate is, erode and small-island dropping are
not), so combining post-`select_colour` is the only combination that keeps
each individual seed's own algorithm result well-defined and byte-
reproducible on its own.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from ml.colour import select_colour
from ml.trace import trace_mask


def handle_select_colour(
    header: dict[str, Any], payload: bytes
) -> tuple[dict[str, Any], bytes]:
    request_id = header.get("id")
    width = header.get("width")
    height = header.get("height")
    seeds = header.get("seeds")
    params = header.get("params") or {}

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
                "error": "select_colour requires positive integer width and height",
            },
            b"",
        )

    if not isinstance(seeds, list) or len(seeds) == 0:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": "select_colour requires at least one seed",
            },
            b"",
        )

    expected_bytes = width * height * 4
    if len(payload) != expected_bytes:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": (
                    f"expected {expected_bytes} payload bytes for {width}x{height} RGBA8, "
                    f"got {len(payload)}"
                ),
            },
            b"",
        )

    rgba = np.frombuffer(payload, dtype=np.uint8).reshape(height, width, 4)

    tolerance = int(params.get("tolerance", 32))
    contiguous = bool(params.get("contiguous", True))
    space = params.get("space", "lab")
    expand = int(params.get("expand", 0))
    min_island = int(params.get("min_island", 16))

    positive = np.zeros((height, width), dtype=bool)
    negative = np.zeros((height, width), dtype=bool)
    try:
        for entry in seeds:
            x = int(entry["x"])
            y = int(entry["y"])
            label = int(entry.get("label", 1))
            seed_mask = select_colour(
                rgba,
                (x, y),
                tolerance=tolerance,
                contiguous=contiguous,
                space=space,
                expand=expand,
                min_island=min_island,
            )
            if label == 1:
                positive |= seed_mask
            else:
                negative |= seed_mask
    except Exception as exc:  # noqa: BLE001 - surfaced to caller as ok:false
        return {"id": request_id, "ok": False, "error": str(exc)}, b""

    mask = positive & ~negative

    polygons = trace_mask(mask, keep_holes=True)
    polygons_json = [[{"x": x, "y": y} for x, y in polygon] for polygon in polygons]

    result_payload = np.ascontiguousarray(mask.astype(np.uint8) * 255).tobytes()
    return (
        {
            "id": request_id,
            "ok": True,
            "width": width,
            "height": height,
            "polygons": polygons_json,
        },
        result_payload,
    )
