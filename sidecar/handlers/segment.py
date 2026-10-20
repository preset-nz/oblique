"""`segment` handler — MobileSAM point/box/mask prompt -> mask + traced
polygons.

Per the protocol: payload is RGBA8 `width*height*4` bytes; if
`prompt.mask` is true, a further 256*256 single-channel byte plane (0/255,
the decoder's coarse mask_input, rasterised client-side from a drawn
outline) follows the image in the same payload, and `payload_bytes` covers
both. Response payload is a single-channel u8 mask (0/255) at the same
size — kept for debugging and for story 3's alpha multiply; `polygons` are
closed outer contours in the same pixel space, holes dropped (v1).

The weights are not fetched here: `model_dir` is the model's folder in app-kit's models
folder, and `segment` answers `ok: false` with `code: "model_missing"` (and the model id in
`model`) when it has no `manifest.json`. Nothing in the sidecar opens a URL.

This module owns all the header parsing and payload byte-slicing for
`segment` — `ml/` (session, trace) stays protocol-free: it never
sees a request header or raw payload bytes, only NumPy arrays, `Path`s,
and the already-unpacked `prompt` dict, so it can move into a shared
package later without carrying this wire format with it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from ml.session import MODEL_ID, ModelNotInstalled, run_segment, weight_paths
from ml.trace import trace_mask

COARSE_MASK_SIDE = 256
COARSE_MASK_BYTES = COARSE_MASK_SIDE * COARSE_MASK_SIDE


def handle_segment(
    header: dict[str, Any], payload: bytes
) -> tuple[dict[str, Any], bytes]:
    request_id = header.get("id")
    width = header.get("width")
    height = header.get("height")
    model_dir = header.get("model_dir")
    prompt = header.get("prompt") or {}

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
                "error": "segment requires positive integer width and height",
            },
            b"",
        )

    if not model_dir:
        return (
            {"id": request_id, "ok": False, "error": "segment requires model_dir"},
            b"",
        )

    wants_mask = bool(prompt.get("mask"))
    image_bytes = width * height * 4
    expected_bytes = image_bytes + (COARSE_MASK_BYTES if wants_mask else 0)
    if len(payload) != expected_bytes:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": (
                    f"expected {expected_bytes} payload bytes for {width}x{height} "
                    f"RGBA8{' + 256x256 coarse mask' if wants_mask else ''}, "
                    f"got {len(payload)}"
                ),
            },
            b"",
        )

    rgba_bytes = payload[:image_bytes]
    rgba = np.frombuffer(rgba_bytes, dtype=np.uint8).reshape(height, width, 4)

    coarse_mask = None
    if wants_mask:
        coarse_bytes = payload[image_bytes : image_bytes + COARSE_MASK_BYTES]
        coarse_mask = np.frombuffer(coarse_bytes, dtype=np.uint8).reshape(
            COARSE_MASK_SIDE, COARSE_MASK_SIDE
        )

    try:
        encoder_path, decoder_path = weight_paths(Path(model_dir))
    except ModelNotInstalled:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": f"model not installed: {MODEL_ID}",
                "code": "model_missing",
                "model": MODEL_ID,
            },
            b"",
        )

    try:
        mask = run_segment(
            encoder_path=encoder_path,
            decoder_path=decoder_path,
            rgba=rgba,
            prompt=prompt,
            coarse_mask=coarse_mask,
        )
    except Exception as exc:  # noqa: BLE001 - per-request guard, must never crash the loop
        return {"id": request_id, "ok": False, "error": str(exc)}, b""

    polygons = trace_mask(mask, keep_holes=False)
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
