"""`pixelate` — flat-mean square-cell mosaic. The cell-decomposition
primitive `crossstitch` will later build on (deferred, its own story).

Fully vectorised, no Python loop over cells: pad to a multiple of
`cell_size` (edge replication, see below), reshape to
`(rows, cell, cols, cell, 4)`, mean over the two cell axes, then
`np.repeat` back up and crop to the original size.

Alpha averages with the colour, but the output alpha channel is left
untouched. Per the op contract, alpha would normally just pass through
unchanged — but a pixelate that averaged RGB while leaving alpha at full
per-pixel detail would draw solid colour blocks with soft, original-
resolution edges, which is visibly wrong (a pixelated cutout should have
blocky edges too). The fix is to average **premultiplied** RGB weighted by
source alpha (i.e. treat alpha as the sample weight), then divide the
premultiplied result back out by the averaged alpha before writing RGB.
A fully transparent source pixel then contributes zero colour to its
cell's average, without the op ever writing to the alpha channel itself —
the "alpha untouched" contract still holds, and RGB now reads as
plausible even where the source was mostly (but not fully) transparent.

Edge cells (partial, at the right/bottom, when the image isn't a multiple
of `cell_size`) must average only the real pixels they cover, not black
or transparent padding — the array is padded with edge replication
(`np.pad(..., mode="edge")`) before the block-mean, so the fill pixels
carry real border values rather than distorting the average.

Draft honesty note: like `cmyk_halftone`, this is a grid op — at 1/8
DRAFT a small `cell_size` scales down and can collapse below one source
pixel. That's the known "screen ops skip draft" gap already recorded in
the roadmap; it isn't solved here, and the scaled value isn't clamped to
hide it beyond the `max(1, ...)` floor needed so the op cannot crash.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op


@op(
    "pixelate",
    label="Pixelate",
    description="Flat-mean square-cell mosaic — each cell renders as one solid colour.",
    params=[
        P(
            "cell_size",
            "int",
            min=1,
            max=256,
            default=8,
            step=1,
            scale="spatial",
        ),
    ],
)
def pixelate(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    cell = max(1, int(params.get("cell_size", 8)))
    h, w = img.shape[:2]

    if cell == 1:
        return img.copy()

    alpha = img[..., 3:4].astype(np.float64) / 255.0
    rgb = img[..., :3].astype(np.float64)
    # Premultiplied RGBA in one array: channels 0-2 are alpha-weighted
    # colour, channel 3 is the weight itself, so a single block-mean over
    # all four channels gives both the weighted colour sum and its
    # normaliser in one vectorised pass.
    premultiplied = np.concatenate([rgb * alpha, alpha], axis=-1)

    pad_h = (-h) % cell
    pad_w = (-w) % cell
    padded = np.pad(premultiplied, ((0, pad_h), (0, pad_w), (0, 0)), mode="edge")

    padded_h, padded_w = padded.shape[:2]
    rows, cols = padded_h // cell, padded_w // cell
    cell_means = padded.reshape(rows, cell, cols, cell, 4).mean(axis=(1, 3))

    weight = cell_means[..., 3:4]
    has_coverage = weight > 1e-8
    safe_weight = np.where(has_coverage, weight, 1.0)
    cell_rgb = np.where(has_coverage, cell_means[..., :3] / safe_weight, 0.0)

    rgb_full = np.repeat(np.repeat(cell_rgb, cell, axis=0), cell, axis=1)[:h, :w]

    out = img.copy()
    out[..., :3] = np.clip(rgb_full, 0.0, 255.0).astype(np.uint8)
    return out
