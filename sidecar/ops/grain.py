"""`grain` — seeded Gaussian noise, generated at a `size`-downscaled
resolution and nearest-neighbour upscaled for a chunky look, added to RGB
and clipped. Same seed + params + shape always produces byte-identical
output (cooks must be reproducible).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op

# Noise std-dev at amount=1.0, in 0-255 pixel value units.
_MAX_STD = 128.0


@op(
    "grain",
    params=[
        P("amount", "float", min=0.0, max=1.0, default=0.1, step=0.01),
        P("size", "int", min=1, max=8, default=1, step=1, scale="spatial"),
        P("seed", "int", min=0, max=2**31 - 1, default=0, step=1),
    ],
)
def grain(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    amount = float(params.get("amount", 0.1))
    size = max(1, int(params.get("size", 1)))
    seed = int(params.get("seed", 0))

    h, w = img.shape[:2]

    if amount <= 0.0:
        return img.copy()

    small_h = max(1, -(-h // size))  # ceil division
    small_w = max(1, -(-w // size))

    rng = np.random.default_rng(seed)
    noise_small = rng.standard_normal((small_h, small_w))
    noise_full = np.repeat(np.repeat(noise_small, size, axis=0), size, axis=1)
    noise_full = noise_full[:h, :w] * (amount * _MAX_STD)

    out = img.copy()
    rgb = out[..., :3].astype(np.float64) + noise_full[..., None]
    out[..., :3] = np.clip(rgb, 0.0, 255.0).astype(np.uint8)
    return out
