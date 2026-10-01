"""`colour_crush` — bit-depth reduction per channel. Posterise's meaner
sibling: instead of a smooth tonal remap, it throws away the low bits of
each channel outright (uniform quantiser), optionally with an ordered
Bayer 4x4 dither to fake back some of the lost gradation. Alpha untouched.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op

# Classic 4x4 Bayer matrix, normalised to [0, 1) thresholds centred on 0.5
# so dithering neither brightens nor darkens the image on average.
_BAYER_4X4 = (
    np.array(
        [
            [0, 8, 2, 10],
            [12, 4, 14, 6],
            [3, 11, 1, 9],
            [15, 7, 13, 5],
        ],
        dtype=np.float64,
    )
    / 16.0
    - 0.5
    + (1.0 / 32.0)
)


def _crush_channel(
    chan: np.ndarray, bits: int, dither_offset: np.ndarray | None
) -> np.ndarray:
    """Quantise one channel [0,255] uint8 to `bits` levels."""
    bits = max(0, min(8, bits))
    if bits >= 8:
        return chan.copy()
    if bits <= 0:
        # Degenerate case: everything collapses to a single level (0).
        return np.zeros_like(chan)

    levels = (1 << bits) - 1
    step = 255.0 / levels

    values = chan.astype(np.float64)
    if dither_offset is not None:
        # Dither offset is in units of one quantisation step, tiled to the
        # channel's shape and centred so it nudges values up or down across
        # the rounding boundary in a stable spatial pattern.
        values = values + dither_offset * step

    q = np.clip(np.round(values / step), 0, levels)
    return (q * step).astype(np.uint8)


def _tiled_bayer(h: int, w: int) -> np.ndarray:
    reps_h = -(-h // 4)
    reps_w = -(-w // 4)
    tiled = np.tile(_BAYER_4X4, (reps_h, reps_w))
    return tiled[:h, :w]


@op(
    "colour_crush",
    label="Colour Crush",
    description="Per-channel bit-depth reduction — posterise's meaner sibling, with optional Bayer dither.",
    params=[
        P("bits", "int", min=1, max=8, default=3, step=1, widget="slider"),
        P("dither", "bool", default=False),
        P("bits_r", "int", min=0, max=8, default=0, step=1, widget="slider"),
        P("bits_g", "int", min=0, max=8, default=0, step=1, widget="slider"),
        P("bits_b", "int", min=0, max=8, default=0, step=1, widget="slider"),
    ],
)
def colour_crush(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    bits = int(params.get("bits", 3))
    dither = bool(params.get("dither", False))
    bits_r = int(params.get("bits_r", 0))
    bits_g = int(params.get("bits_g", 0))
    bits_b = int(params.get("bits_b", 0))

    h, w = img.shape[:2]
    offset = _tiled_bayer(h, w) if dither else None

    out = img.copy()
    per_channel_bits = (bits_r or bits, bits_g or bits, bits_b or bits)
    for i, ch_bits in enumerate(per_channel_bits):
        out[..., i] = _crush_channel(img[..., i], ch_bits, offset)
    return out
