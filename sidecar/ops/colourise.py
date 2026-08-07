"""`colourise` — GIMP-colorize in shape: throw away the source hue, keep
the luminance, tint with a single ink. Rec. 709 luma (`ops.LUMA_R709` etc.,
the same weights `desaturate`/`xerox` use) multiplied by the target colour
gives the tinted result; blending that against the source RGB by `amount`
makes the op usable at partial strength. Alpha untouched.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, hex_to_rgb01, op

_DEFAULT_COLOUR = "#7a5c3a"
# Fallback tuple lives at module scope so a garbled colour string falls back
# to this op's own documented default, parsed once rather than on every call.
_DEFAULT_COLOUR_RGB01 = hex_to_rgb01(_DEFAULT_COLOUR, (0.0, 0.0, 0.0))


@op(
    "colourise",
    label="Colourise",
    description="Tint the image with a single ink, keeping the source luminance.",
    params=[
        P("colour", "color", default=_DEFAULT_COLOUR),
        P(
            "amount",
            "float",
            min=0.0,
            max=1.0,
            default=1.0,
            step=0.05,
            widget="slider",
        ),
        P("preserve_luma", "bool", default=True),
    ],
)
def colourise(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    amount = max(0.0, min(1.0, float(params.get("amount", 1.0))))
    preserve_luma = bool(params.get("preserve_luma", True))

    out = img.copy()
    if amount <= 0.0:
        return out

    r01, g01, b01 = hex_to_rgb01(
        params.get("colour", _DEFAULT_COLOUR), _DEFAULT_COLOUR_RGB01
    )
    colour = np.array([r01, g01, b01], dtype=np.float64) * 255.0

    rgb = img[..., :3].astype(np.float64)
    src_luma = (
        rgb[..., 0] * LUMA_R709 + rgb[..., 1] * LUMA_G709 + rgb[..., 2] * LUMA_B709
    )

    # Classic tint: mid-grey times a mid-colour is dark, which is the
    # expected "colorize" darkening with preserve_luma off.
    tinted = (src_luma[..., None] / 255.0) * colour[None, None, :]

    if preserve_luma:
        tinted_luma = (
            tinted[..., 0] * LUMA_R709
            + tinted[..., 1] * LUMA_G709
            + tinted[..., 2] * LUMA_B709
        )
        # Rescale the tinted result so its own luma matches the source
        # pixel's, so a colourised image stays as bright as the original.
        # Guard the near-black tinted colour (division blow-up) by only
        # rescaling where there's something to rescale.
        scale = np.ones_like(tinted_luma)
        safe = tinted_luma > 1e-6
        scale[safe] = src_luma[safe] / tinted_luma[safe]
        tinted = tinted * scale[..., None]
        tinted = np.clip(tinted, 0.0, 255.0)

    blended = rgb + (tinted - rgb) * amount
    out[..., :3] = np.clip(blended, 0.0, 255.0).astype(np.uint8)
    return out
