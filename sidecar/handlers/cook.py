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

Drivers (Epic 27, `features/27-driven-params/blur-radius.md`): a modifier may
carry a driver plane, one single-channel byte per pixel, after the mask planes.
The header entry is `{modifierIndex, kind, driver_bytes}`; `kind` must be one
the op offers. The op receives it as `drivers={kind: float32 0..1 plane}`
beside `params`. Ops with no driver attached are called as they always were,
and a frame with no `drivers` key is the pre-driver frame, byte for byte.

Histograms (Epic 27, `features/27-driven-params/levels-curve.md`): the header may
carry `histograms`, a list of modifier indexes whose op declares
`@op(histogram=True)`. The response then carries `histograms`, one entry
`{modifierIndex, luma, r, g, b}` per index: 256 bin counts of the picture as it
ARRIVES at that modifier (before the op, and before its mask). Without the
request key the response has no `histograms` key, so an ordinary cook is the
frame it always was, byte for byte.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np
from ops import LUMA_B709, LUMA_G709, LUMA_R709, OPS, Op

HISTOGRAM_BINS = 256


def histogram_bins(img: np.ndarray) -> dict[str, list[int]]:
    """256-bin counts of an RGBA8 picture: `luma` (Rec. 709 weights, `LUMA_*709` in
    `ops`, the sidecar's one definition of grey, rounded to a bin) and `r`, `g`, `b`.

    Fully transparent pixels are left out: they show nothing, and a cut-out's empty
    area would otherwise stand as a spike in the blacks. Pure; reads `img` only.
    """
    visible = img[..., 3] > 0
    rgb = img[..., :3][visible]
    luma = np.rint(
        rgb[:, 0] * LUMA_R709 + rgb[:, 1] * LUMA_G709 + rgb[:, 2] * LUMA_B709
    ).astype(np.intp)
    bins: dict[str, list[int]] = {
        "luma": np.bincount(luma, minlength=HISTOGRAM_BINS)[:HISTOGRAM_BINS].tolist()
    }
    for index, name in enumerate("rgb"):
        bins[name] = np.bincount(rgb[:, index], minlength=HISTOGRAM_BINS).tolist()
    return bins


def _run(
    entry: Op,
    img: np.ndarray,
    params: dict[str, Any],
    driven: dict[str, np.ndarray] | None,
) -> np.ndarray:
    """One op call. An op with no driver attached is called exactly as before
    drivers existed: `fn(img, params)`."""
    if driven is None:
        return entry.fn(img, params)
    return entry.fn(img, params, driven)


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

    # Optional per-modifier drivers: planes appended after the mask planes, in
    # header order, one per entry. A modifier has at most one.
    driver_entries = header.get("drivers", [])
    seen_drivers: set[int] = set()
    for entry in driver_entries:
        index = entry.get("modifierIndex")
        kind = entry.get("kind")
        size = entry.get("driver_bytes")
        if not isinstance(index, int) or not 0 <= index < len(modifiers):
            return {
                "id": request_id,
                "ok": False,
                "error": f"driver modifierIndex {index!r} out of range",
            }, b""
        op_name = modifiers[index]["type"]
        if kind not in {d.kind for d in OPS[op_name].drivers}:
            return {
                "id": request_id,
                "ok": False,
                "error": f"op '{op_name}' offers no driver {kind!r}",
            }, b""
        if index in seen_drivers:
            return {
                "id": request_id,
                "ok": False,
                "error": f"modifier {index} has more than one driver",
            }, b""
        seen_drivers.add(index)
        if size != mask_plane_bytes:
            return {
                "id": request_id,
                "ok": False,
                "error": (
                    f"driver for modifier {index} must be {mask_plane_bytes} bytes "
                    f"({width}x{height} single-channel), got {size!r}"
                ),
            }, b""

    # Optional histograms: the modifier indexes whose input bins are wanted.
    histogram_indexes = header.get("histograms", [])
    for index in histogram_indexes:
        if not isinstance(index, int) or not 0 <= index < len(modifiers):
            return {
                "id": request_id,
                "ok": False,
                "error": f"histogram modifier index {index!r} out of range",
            }, b""
        op_name = modifiers[index]["type"]
        if not OPS[op_name].histogram:
            return {
                "id": request_id,
                "ok": False,
                "error": f"op '{op_name}' offers no histogram",
            }, b""

    image_bytes = width * height * 4
    expected_bytes = image_bytes + mask_plane_bytes * (
        len(mask_entries) + len(driver_entries)
    )
    if len(payload) != expected_bytes:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": (
                    f"expected {expected_bytes} payload bytes for "
                    f"{width}x{height} RGBA8 + {len(mask_entries)} mask(s)"
                    f" + {len(driver_entries)} driver(s), got {len(payload)}"
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

    # And each driver plane: 0..1 float32 (k / 255), keyed by modifier.
    drivers_by_index: dict[int, dict[str, np.ndarray]] = {}
    for entry in driver_entries:
        plane = np.frombuffer(
            payload[offset : offset + mask_plane_bytes], dtype=np.uint8
        ).reshape(height, width)
        drivers_by_index[entry["modifierIndex"]] = {
            entry["kind"]: plane.astype(np.float32) / np.float32(255.0)
        }
        offset += mask_plane_bytes

    # Per-op wall time in ms, returned in the header for client-side debug
    # logging. perf_counter reads cost ~ns against ops that cost ms, so the
    # measurement can't skew what it measures.
    timings_ms: list[dict[str, Any]] = []
    histograms: list[dict[str, Any]] = []
    for index, modifier in enumerate(modifiers):
        entry = OPS[modifier["type"]]
        if index in histogram_indexes:
            histograms.append({"modifierIndex": index, **histogram_bins(img)})
        started = time.perf_counter()
        mask = masks_by_index.get(index)
        driven = drivers_by_index.get(index)
        params = modifier.get("params", {})
        if mask is None:
            img = _run(entry, img, params, driven)
        else:
            # Masked modifier: blend the op's output against the buffer that
            # ENTERED it — mask*out + (1-mask)*before, all four channels.
            # Ops return fresh arrays and never mutate their input (module
            # docstring above), so holding `before` needs no copy. The blend
            # wraps the op call; the op itself stays pure and mask-unaware,
            # and the run is not split (selection-to-mask.md §Decision).
            before = img
            out = _run(entry, img, params, driven)
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
    response: dict[str, Any] = {
        "id": request_id,
        "ok": True,
        "width": width,
        "height": height,
        "timings_ms": timings_ms,
    }
    if histograms:
        response["histograms"] = histograms
    return response, result
