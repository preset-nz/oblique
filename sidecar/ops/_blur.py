"""Shared float box-blur helper.

Private module (leading underscore) — not an op itself, just a primitive
a handful of ops share. Hand-rolled because there is no `scipy` in the
sidecar and Pillow's `ImageFilter.GaussianBlur` cannot operate on
float ("F" mode) arrays (`ValueError: image has wrong mode`, verified
against the pinned Pillow 12.3.0) — a hard blocker for any op that needs
to blur premultiplied float data (e.g. alpha-weighted colour) rather
than plain 8-bit RGB, or whose falloff is wide/faint enough that 8-bit
quantisation would band visibly.

`soften` is a 3-pass separable box blur, which approximates a Gaussian
closely enough for this codebase's purposes at a fraction of the cost of
a true Gaussian kernel. `box_blur_1d` is the single-axis primitive it
composes.

Callers: `edge_noise.py` (softening alpha to find the boundary normal)
and `bloom.py` (softening the alpha-weighted highlight layer).
"""

from __future__ import annotations

import numpy as np


def box_blur_1d(arr: np.ndarray, axis: int, radius: int) -> np.ndarray:
    """Edge-padded box blur along one axis, `radius` px each side."""
    if radius <= 0:
        return arr
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (radius, radius)
    padded = np.pad(arr, pad, mode="edge")
    n = 2 * radius + 1
    cumsum = np.cumsum(padded, axis=axis)
    zeros_shape = list(cumsum.shape)
    zeros_shape[axis] = 1
    cumsum = np.concatenate(
        [np.zeros(zeros_shape, dtype=cumsum.dtype), cumsum], axis=axis
    )
    size = arr.shape[axis]
    sl_hi = [slice(None)] * arr.ndim
    sl_hi[axis] = slice(n, n + size)
    sl_lo = [slice(None)] * arr.ndim
    sl_lo[axis] = slice(0, size)
    return (cumsum[tuple(sl_hi)] - cumsum[tuple(sl_lo)]) / n


def soften(arr: np.ndarray, radius: float) -> np.ndarray:
    """Cheap 3-pass box blur (approximates a Gaussian) at `radius` px,
    applied separably. Plain NumPy — no `scipy` in the sidecar."""
    r = max(1, int(round(radius)))
    out = arr
    for _ in range(3):
        out = box_blur_1d(out, axis=0, radius=r)
        out = box_blur_1d(out, axis=1, radius=r)
    return out
