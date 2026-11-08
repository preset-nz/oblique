"""`levels` — classic black/white/gamma remap, with output black and white, via a single
256-entry LUT."""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op


@op(
    "levels",
    category="colour",
    label="Levels",
    description="Classic black/white/gamma tonal remap via a single LUT.",
    histogram=True,
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
            widget="curve",
            curve={
                "black": "black",
                "white": "white",
                "out_black": "out_black",
                "out_white": "out_white",
            },
            description="Midtone brightness. Above 1 lightens the midtones; below 1 darkens them.",
        ),
        P(
            "out_black",
            "float",
            min=0.0,
            max=255.0,
            default=0.0,
            step=1.0,
            label="Output black",
            description="Value, 0 to 255, that pure black becomes. Raising it lifts the shadows to grey, a faded matte look.",
        ),
        P(
            "out_white",
            "float",
            min=0.0,
            max=255.0,
            default=255.0,
            step=1.0,
            label="Output white",
            description="Value, 0 to 255, that pure white becomes. Lowering it dulls the highlights to grey.",
        ),
    ],
)
def levels(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    black = float(params.get("black", 0.0))
    white = float(params.get("white", 255.0))
    gamma = float(params.get("gamma", 1.0))
    out_black = float(params.get("out_black", 0.0))
    out_white = float(params.get("out_white", 255.0))

    # Guard white <= black by clamping to black + 1, per spec.
    if white <= black:
        white = black + 1.0
    # Same guard on the output side, so the ends never cross (no inverting through levels).
    if out_white <= out_black:
        out_white = out_black + 1.0

    domain = np.arange(256, dtype=np.float64)
    normalised = np.clip((domain - black) / (white - black), 0.0, 1.0)
    # At the defaults this is `power * 255.0 + 0.0`: the same float ops as before output
    # black and white existed, so old files cook to the same bytes.
    lut = np.clip(
        np.power(normalised, 1.0 / gamma) * (out_white - out_black) + out_black,
        0.0,
        255.0,
    )
    lut = lut.astype(np.uint8)

    out = img.copy()
    out[..., :3] = lut[out[..., :3]]
    return out
