"""Shared disc morphology helper for `dilate` and `erode`.

Private module (leading underscore) — not an op itself, just the
implementation both registrations share. See
`guidance/projects/oblique/features/16-alpha-and-edges/dilate-and-erode.md`
for the full contract this exists to satisfy.

**The shape is alpha. RGB follows it.**

`erode` min-filters alpha over a disc of `radius` and leaves RGB
untouched entirely — pixels that lose coverage keep whatever colour they
had; the compositor never reads it once they're transparent.

`dilate` max-filters alpha over the same disc. RGB for newly-covered
pixels (alpha that rose from near-zero) is recovered from a
premultiplied max-filter over the same footprint, so it borrows colour
from the nearest previously-opaque neighbour rather than dragging in the
arbitrary RGB the frame protocol's non-premultiplied transparent pixels
carry. Previously-opaque pixels always keep their own RGB exactly,
regardless of what the max-filtered premultiplied value would suggest —
that's the whole reason RGB recovery is masked by "was this pixel
already opaque", not applied unconditionally.

No `scipy` in the sidecar (verified: not a dependency), so this is a
plain-NumPy disc filter, decomposed into per-row horizontal runs over a
sparse table (see `_filter_disc`). 2026-10-02: ~16x faster at r=24 and
~46x at r=64 on a WORKING-size plane than the per-offset version it
replaced, byte-identical.

Sub-pixel radii matter because `scale: "spatial"` pre-multiplies by the
resolution factor before the radius reaches this op — a 4 px dilate at
DRAFT (1/8) arrives as 0.5. Flooring that to 0 would make the draft
preview structurally different from the full-res cook, which the
resolution ladder must never do. So the filter is applied at both the
floor and ceiling integer radius and linearly blended by the fractional
part, on the *soft* (float) alpha — never thresholded — so an
anti-aliased or feathered edge stays a gradient, just shifted.
"""

from __future__ import annotations

import numpy as np

_NEAR_ZERO_ALPHA = 1e-3


def _disc_offsets(radius: int) -> list[tuple[int, int]]:
    """Integer (dy, dx) offsets within `radius` px of the centre, disc
    shaped (not the square footprint a plain PIL MaxFilter would give)."""
    offsets: list[tuple[int, int]] = []
    r2 = radius * radius
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dy * dy + dx * dx <= r2:
                offsets.append((dy, dx))
    return offsets


def _filter_disc(arr: np.ndarray, radius: int, mode: str) -> np.ndarray:
    """Grey dilation (`mode="max"`) or erosion (`mode="min"`) of `arr`
    (2D or 3D, float) over a disc of `radius` px. Edge-padded so pixels
    beyond the canvas don't drag in a phantom 0 or 1.

    Row decomposition: the disc is, for each row offset `dy`, a horizontal
    run of half-width `floor(sqrt(r^2 - dy^2))` — exactly the
    `_disc_offsets` membership test. Each run's max/min comes from a
    power-of-two sparse table along x (two overlapping lookups), so the
    cost is ~2·(2r+1) whole-array ops instead of ~πr^2. Max/min only
    select, never combine, so the result is byte-identical to the
    per-offset reference (`tests/test_morphology_fast.py` pins that).
    """
    if radius <= 0:
        return arr.copy()

    op = np.maximum if mode == "max" else np.minimum
    pad_width = [(radius, radius), (radius, radius)] + [(0, 0)] * (arr.ndim - 2)
    padded = np.pad(arr, pad_width, mode="edge")
    h, w = arr.shape[:2]

    # tables[k][:, x] = op over padded[:, x : x + 2**k]
    tables = [padded]
    span = 1
    while span * 2 <= 2 * radius + 1:
        prev = tables[-1]
        n = prev.shape[1] - span
        tables.append(op(prev[:, :n, ...], prev[:, span : span + n, ...]))
        span *= 2

    acc: np.ndarray | None = None
    for dy in range(-radius, radius + 1):
        half = int(np.floor(np.sqrt(radius * radius - dy * dy)))
        width = 2 * half + 1
        k = width.bit_length() - 1
        size = 1 << k
        table = tables[k]
        rows = slice(radius + dy, radius + dy + h)
        x0 = radius - half
        x1 = x0 + width - size
        run = op(table[rows, x0 : x0 + w, ...], table[rows, x1 : x1 + w, ...])
        if acc is None:
            acc = run.copy()
        else:
            op(acc, run, out=acc)
    assert acc is not None
    return acc


def apply_morphology(img: np.ndarray, radius: float, *, grow: bool) -> np.ndarray:
    """Shared body of `dilate` (`grow=True`) and `erode` (`grow=False`).
    Input never mutated; output is RGBA8, same shape."""
    out = img.copy()
    if radius <= 0.0:
        return out

    mode = "max" if grow else "min"
    r0 = int(np.floor(radius))
    r1 = r0 + 1
    frac = radius - r0

    alpha0 = img[..., 3].astype(np.float64) / 255.0

    def alpha_at(r: int) -> np.ndarray:
        return alpha0 if r <= 0 else _filter_disc(alpha0, r, mode)

    a0 = alpha_at(r0)
    new_alpha = a0 if frac == 0.0 else a0 * (1.0 - frac) + alpha_at(r1) * frac

    if grow:
        rgb0 = img[..., :3].astype(np.float64) / 255.0
        premult0 = rgb0 * alpha0[..., None]

        def premult_at(r: int) -> np.ndarray:
            return premult0 if r <= 0 else _filter_disc(premult0, r, "max")

        p0 = premult_at(r0)
        new_premult = p0 if frac == 0.0 else p0 * (1.0 - frac) + premult_at(r1) * frac

        safe_alpha = np.where(new_alpha > _NEAR_ZERO_ALPHA, new_alpha, 1.0)
        recovered_rgb = np.clip(new_premult / safe_alpha[..., None], 0.0, 1.0)

        was_opaque = alpha0 > _NEAR_ZERO_ALPHA
        has_coverage = new_alpha > _NEAR_ZERO_ALPHA
        # Previously-opaque pixels keep their own RGB exactly; newly-covered
        # ones (no coverage before, some now) take the nearest-opaque colour
        # recovered above; pixels with no coverage either way keep their
        # (unobservable) original RGB untouched.
        out_rgb = np.where(was_opaque[..., None], rgb0, recovered_rgb)
        out_rgb = np.where(has_coverage[..., None], out_rgb, rgb0)

        out[..., :3] = np.clip(out_rgb * 255.0, 0.0, 255.0).astype(np.uint8)

    out[..., 3] = np.clip(new_alpha * 255.0, 0.0, 255.0).astype(np.uint8)
    return out
