"""`levels` — classic black/white/gamma remap via a single 256-entry LUT."""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op


@op(
    "levels",
    category="colour",
    label="Levels",
    description="Classic black/white/gamma tonal remap via a single LUT.",
    params=[
        P(
            "black",
            "float",
            min=0.0,
            max=255.0,
            default=0.0,
            step=1.0,
            label="Black point",
            description="Input value, 0 to 255, that becomes pure black. Raising it darkens the shadows.",
        ),
        P(
            "white",
            "float",
            min=0.0,
            max=255.0,
            default=255.0,
            step=1.0,
            label="White point",
            description="Input value, 0 to 255, that becomes pure white. Lowering it brightens the highlights.",
        ),
        P(
            "gamma",
            "float",
            min=0.1,
            max=5.0,
            default=1.0,
            step=0.05,
            label="Gamma",
            description="Midtone brightness. Above 1 lightens the midtones; below 1 darkens them.",
        ),
    ],
)
def levels(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    black = float(params.get("black", 0.0))
    white = float(params.get("white", 255.0))
    gamma = float(params.get("gamma", 1.0))

    # Guard white <= black by clamping to black + 1, per spec.
    if white <= black:
        white = black + 1.0

    domain = np.arange(256, dtype=np.float64)
    normalised = np.clip((domain - black) / (white - black), 0.0, 1.0)
    lut = np.clip(np.power(normalised, 1.0 / gamma) * 255.0, 0.0, 255.0)
    lut = lut.astype(np.uint8)

    out = img.copy()
    out[..., :3] = lut[out[..., :3]]
    return out
