"""`gaussian_blur` — Pillow `GaussianBlur` on RGB only; alpha untouched.

Radius is authored in document pixels; the client pre-scales it by the
resolution factor (draft 1/8, working 1/2, full 1) before sending, so
preview levels look the same on screen (`scale: "spatial"` below).
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from ops import P, op


@op(
    "gaussian_blur",
    label="Gaussian Blur",
    description="Even, soft blur across the RGB channels — alpha stays untouched.",
    params=[
        P(
            "radius",
            "float",
            min=0.0,
            max=100.0,
            default=4.0,
            step=0.1,
            scale="spatial",
            label="Radius",
            description="Blur radius in document pixels. Larger is softer; 0 does nothing.",
        ),
    ],
)
def gaussian_blur(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    radius = float(params.get("radius", 4.0))

    out = img.copy()
    if radius <= 0.0:
        return out

    rgb = Image.fromarray(out[..., :3], mode="RGB")
    blurred = rgb.filter(ImageFilter.GaussianBlur(radius=radius))
    out[..., :3] = np.asarray(blurred, dtype=np.uint8)
    return out
