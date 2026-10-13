"""Shared seeded value-noise field.

Private module (leading underscore) — not an op itself, just a primitive a
handful of ops share. Hand-rolled because there is no noise library in the
sidecar: low-resolution white noise from a seeded RNG, upsampled to the
full image size. The `profile` param picks how that low-res field is
turned into the full-size field — five variants, described where
`edge_noise.py` first introduced them (its module docstring), reproduced
here verbatim:

- `smooth` (default) — bicubic upsample. Byte-identical to the
  pre-`profile` op for every param combination.
- `linear` — bilinear upsample: "connect the dots". Straight runs between
  noise points with a corner at each, so tears are polygonal rather than
  curved.
- `rect` — the same low-res field, upsampled with nearest-neighbour
  instead of bicubic, so the boundary steps in flat square blocks.
- `saw` — the bicubic-upsampled field folded into a ridge/triangle wave
  (`1 - 2*abs(v)`), which turns smooth wander into sharp, regularly-spaced
  teeth.
- `straight` — nearest-neighbour upsample of a *coarser* field (3x the
  normal cell size), giving a few large flat displacements — long
  straight rips with hard corners rather than fine texture.

Values are bounded to roughly [-1, 1].

Callers: `edge_noise.py` (boundary wobble, imported back under its
original private name `_noise_field`) and `film_burn.py` (the burn
field's boundary wobble).
"""

from __future__ import annotations

import numpy as np
from PIL import Image


def noise_field(h: int, w: int, scale: float, seed: int, profile: str) -> np.ndarray:
    """Seeded value-noise field at feature size `scale`, upsampled to
    `(h, w)` per `profile` — see the module docstring for the five
    variants. Values are bounded to roughly [-1, 1]."""
    rng = np.random.default_rng(seed)
    field_scale = scale * 3.0 if profile == "straight" else scale
    small_h = max(1, round(h / field_scale))
    small_w = max(1, round(w / field_scale))
    noise_small = rng.uniform(-1.0, 1.0, size=(small_h, small_w)).astype(np.float32)
    noise_img = Image.fromarray(noise_small, mode="F")

    if profile in ("rect", "straight"):
        return np.asarray(
            noise_img.resize((w, h), resample=Image.NEAREST), dtype=np.float64
        )

    if profile == "linear":
        # Connect the dots: straight runs between noise points, corners at
        # each cell — polygonal tears rather than a bezier wander.
        return np.asarray(
            noise_img.resize((w, h), resample=Image.BILINEAR), dtype=np.float64
        )

    noise_full = np.asarray(
        noise_img.resize((w, h), resample=Image.BICUBIC), dtype=np.float64
    )
    if profile == "saw":
        # Ridge/triangle wave: folds the smooth [-1, 1] wander into sharp
        # teeth, still bounded to [-1, 1].
        noise_full = 1.0 - 2.0 * np.abs(noise_full)
    return noise_full
