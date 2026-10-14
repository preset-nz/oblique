"""`threshold` — Rec.709 luminance step (optionally smoothstepped). RGBA out,
grey duplicated across R/G/B, alpha untouched.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op

# Rec. 709 luma weights.
_LUMA_R, _LUMA_G, _LUMA_B = 0.2126, 0.7152, 0.0722


@op(
    "threshold",
    category="print",
    label="Threshold",
    description="Hard (or smoothstepped) luminance cut to pure black and white.",
    params=[
        P(
            "level",
            "float",
            min=0.0,
            max=255.0,
            default=127.0,
            step=1.0,
            label="Level",
            description="Luminance cut-off, 0 to 255. Pixels at or above it turn white and the rest black, so higher gives more black.",
        ),
        P(
            "smooth",
            "float",
            min=0.0,
            max=64.0,
            default=0.0,
            step=1.0,
            label="Softness",
            description="Width of the soft transition around the level, in luminance steps. 0 is a hard cut.",
        ),
    ],
)
def threshold(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    level = float(params.get("level", 127.0))
    smooth = float(params.get("smooth", 0.0))

    rgb = img[..., :3].astype(np.float64)
    luminance = rgb[..., 0] * _LUMA_R + rgb[..., 1] * _LUMA_G + rgb[..., 2] * _LUMA_B

    if smooth <= 0.0:
        grey = np.where(luminance >= level, 255.0, 0.0)
    else:
        edge0 = level - smooth / 2.0
        edge1 = level + smooth / 2.0
        t = np.clip((luminance - edge0) / (edge1 - edge0), 0.0, 1.0)
        t = t * t * (3.0 - 2.0 * t)  # smoothstep
        grey = t * 255.0

    grey_u8 = np.clip(grey, 0.0, 255.0).astype(np.uint8)

    out = img.copy()
    out[..., 0] = grey_u8
    out[..., 1] = grey_u8
    out[..., 2] = grey_u8
    return out
