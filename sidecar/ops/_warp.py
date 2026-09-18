"""Shared bilinear sampler for coordinate-warp ops.

Private module (leading underscore) — not an op itself, just a primitive
a handful of ops share. Hand-rolled because there is no `scipy` in the
sidecar: every warp op (displace a pixel's sampling coordinate rather
than its value) needs to gather from a source array at fractional
coordinates, clamped to the canvas edges rather than wrapping or
producing out-of-bounds garbage.

Callers: `edge_noise.py` (sampling the original alpha at a
noise-displaced coordinate, imported back under its original private
name `_bilinear_sample`) and `film_burn.py` (sampling RGBA at the
blister's outward-displaced coordinate).
"""

from __future__ import annotations

import numpy as np


def bilinear_sample(arr: np.ndarray, ys: np.ndarray, xs: np.ndarray) -> np.ndarray:
    """Bilinearly sample 2D float `arr` at fractional coordinates `ys`,
    `xs` (same shape as `arr`), clamped to the canvas edges."""
    h, w = arr.shape
    ys = np.clip(ys, 0.0, h - 1.0)
    xs = np.clip(xs, 0.0, w - 1.0)

    y0 = np.floor(ys).astype(np.int64)
    x0 = np.floor(xs).astype(np.int64)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)

    fy = ys - y0
    fx = xs - x0

    top = arr[y0, x0] * (1.0 - fx) + arr[y0, x1] * fx
    bottom = arr[y1, x0] * (1.0 - fx) + arr[y1, x1] * fx
    return top * (1.0 - fy) + bottom * fy
