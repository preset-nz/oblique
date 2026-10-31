"""`depth` handler: Depth Anything V2 Small, an RGBA raster -> a grey depth map as a PNG.

Request header: `width`, `height`, `model_dir`, and `bits` (8 or 16, default 8). Payload is
RGBA8, `width*height*4` bytes. The response payload is the finished PNG, not raw pixels: Pillow
can't write 16-bit grey with alpha and a canvas can't write 16-bit at all, so the sidecar
encodes and the client writes the bytes as they are. Header: `width`, `height`, `bits`.

The map is relative depth, near white, at the source's size, with the source's alpha kept (so a
cut-out gives a cut-out depth map). 8-bit is grey+alpha (Pillow `LA`); 16-bit is a colour-type-4
PNG built here with `zlib` and `struct`.

The weights are not fetched here: `model_dir` is the model's folder in app-kit's models folder,
and `depth` answers `ok: false` with `code: "model_missing"` (and the model id in `model`) when
it has no `manifest.json`. Nothing in the sidecar opens a URL.

This module owns the header parsing and the PNG bytes; `ml/depth.py` stays protocol-free.
"""

from __future__ import annotations

import io
import struct
import zlib
from pathlib import Path
from typing import Any

import numpy as np
from ml.depth import MODEL_ID, quantise, run_depth, weight_path
from ml.session import ModelNotInstalled
from PIL import Image

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def encode_grey_alpha_png(grey: np.ndarray, alpha: np.ndarray, bits: int) -> bytes:
    """A grey+alpha PNG. `grey` is uint8 (`bits` 8) or uint16 (`bits` 16); `alpha` is uint8
    (H, W) either way, widened to 16 bits exactly (x * 257) for the 16-bit file."""
    height, width = grey.shape
    if bits == 16:
        pixels = np.stack([grey, alpha.astype(np.uint16) * 257], axis=-1).astype(">u2")
        raw = np.ascontiguousarray(pixels).reshape(height, width * 2).view(np.uint8)
        rows = np.concatenate([np.zeros((height, 1), dtype=np.uint8), raw], axis=1)
        header = struct.pack(">IIBBBBB", width, height, 16, 4, 0, 0, 0)
        return (
            _PNG_SIGNATURE
            + _chunk(b"IHDR", header)
            + _chunk(b"IDAT", zlib.compress(rows.tobytes(), 6))
            + _chunk(b"IEND", b"")
        )
    out = io.BytesIO()
    la = np.stack([grey, alpha], axis=-1)
    Image.fromarray(la, "LA").save(out, format="PNG")
    return out.getvalue()


def handle_depth(
    header: dict[str, Any], payload: bytes
) -> tuple[dict[str, Any], bytes]:
    request_id = header.get("id")
    width = header.get("width")
    height = header.get("height")
    model_dir = header.get("model_dir")
    bits = header.get("bits", 8)

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
                "error": "depth requires positive integer width and height",
            },
            b"",
        )

    if bits not in (8, 16):
        return (
            {"id": request_id, "ok": False, "error": "depth bits must be 8 or 16"},
            b"",
        )

    if not model_dir:
        return (
            {"id": request_id, "ok": False, "error": "depth requires model_dir"},
            b"",
        )

    expected_bytes = width * height * 4
    if len(payload) != expected_bytes:
        return (
            {
                "id": request_id,
                "ok": False,
                "error": (
                    f"expected {expected_bytes} payload bytes for {width}x{height} "
                    f"RGBA8, got {len(payload)}"
                ),
            },
            b"",
        )

    try:
        model_path = weight_path(Path(model_dir))
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

    rgba = np.frombuffer(payload, dtype=np.uint8).reshape(height, width, 4)
    try:
        depth = run_depth(model_path=model_path, rgba=rgba)
        png = encode_grey_alpha_png(
            quantise(depth, bits), np.ascontiguousarray(rgba[..., 3]), bits
        )
    except Exception as exc:  # noqa: BLE001 - per-request guard, must never crash the loop
        return {"id": request_id, "ok": False, "error": str(exc)}, b""

    return (
        {"id": request_id, "ok": True, "width": width, "height": height, "bits": bits},
        png,
    )
