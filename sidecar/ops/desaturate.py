"""`desaturate` — blend each pixel's colour toward its Rec. 709 luma by a
chosen amount. Uses the same luma weights as `xerox`'s mono conversion
(`ops.LUMA_R709` etc., lifted to the registry module rather than defined
twice), so the two ops agree on what grey means.

Georg, 2026-07-05: at `amount=1.0` this *is* full greyscale conversion, so
no separate `grayscale`/`greyscale` op exists or should be added — this op
covers that case outright. Alpha untouched.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, op


@op(
    "desaturate",
    label="Desaturate",
    description="Blend the image toward Rec. 709 greyscale by a chosen amount.",
    params=[
        P(
            "amount",
            "float",
            min=0.0,
            max=1.0,
            default=1.0,
            step=0.05,
            widget="slider",
            label="Amount",
            description="How far colour is pulled toward greyscale. 0 leaves the image unchanged; 1 is full greyscale.",
        ),
    ],
)
def desaturate(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    amount = max(0.0, min(1.0, float(params.get("amount", 1.0))))

    out = img.copy()
    if amount <= 0.0:
        return out

    rgb = img[..., :3].astype(np.float64)
    luma = (
        rgb[..., 0] * LUMA_R709 + rgb[..., 1] * LUMA_G709 + rgb[..., 2] * LUMA_B709
    )[..., None]

    blended = rgb + (luma - rgb) * amount
    out[..., :3] = np.clip(blended, 0.0, 255.0).astype(np.uint8)
    return out
