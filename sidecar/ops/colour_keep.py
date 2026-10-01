"""`colour_keep` — desaturate everything except the chosen colours (the
*Sin City* / *Schindler's List* red coat). Pixels whose hue falls inside a
kept band stay as they are; everything else is blended toward its Rec. 709
luma, with the same weights `desaturate` uses (`ops.LUMA_R709` etc.), so
`amount=1` outside the band is exactly `desaturate`'s full greyscale. Alpha
untouched.

**Kept band.** The `keep` colour's hue is the centre. `hue_range` is the
half-width of the band in degrees and `softness` the width of a smoothstep
falloff beyond it, so a band edge doesn't posterise. Hue distance wraps at
360 degrees, so keeping red at 355 degrees also keeps 5 degrees. A
swatch with no colour of its own (a pure grey) has no hue; by the usual
convention it counts as hue 0 (red).

**Near-grey pixels never count as kept.** A grey pixel's hue is noise, and
so is a dark shadow's, so a reddish shadow would otherwise light up.
`min_saturation` is measured as chroma, `(max - min) / 255` of the RGB
channels, rather than HSV saturation, because HSV saturation is large for
near-black pixels; chroma is small for them, which is what the gate wants.
The gate is a smoothstep from half of `min_saturation` (never kept) to
`min_saturation` (fully eligible), so the cut is not a hard edge either.

**Second band.** `use_keep_2` switches on `keep_2`/`hue_range_2`; the panel
greys them out while it is off. It shares `softness` and `min_saturation`
with the first band. A pixel's keep weight is the larger of the two bands'.
Two hues cover most real uses; a colour list waits for the list field kind,
same as `recolour`.

Live against the image beneath it, unlike a colour-range select mask, which
is a frozen selection (Epic 17).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, hex_to_rgb01, op

_DEFAULT_KEEP = "#d02020"
_DEFAULT_KEEP_2 = "#2060d0"
_DEFAULT_KEEP_RGB01 = hex_to_rgb01(_DEFAULT_KEEP, (1.0, 0.0, 0.0))
_DEFAULT_KEEP_2_RGB01 = hex_to_rgb01(_DEFAULT_KEEP_2, (0.0, 0.0, 1.0))


def _clamp(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _hue_degrees(rgb: np.ndarray) -> np.ndarray:
    """HSV hue in degrees `[0, 360)` for float RGB `(..., 3)`; 0 for greys."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    chroma = mx - mn
    safe = np.where(chroma > 0, chroma, 1.0)
    h = np.where(
        mx == r,
        ((g - b) / safe) % 6.0,
        np.where(mx == g, (b - r) / safe + 2.0, (r - g) / safe + 4.0),
    )
    return np.where(chroma > 0, h * 60.0, 0.0)


def _band_weight(
    hue: np.ndarray, centre: float, half_width: float, softness: float
) -> np.ndarray:
    """1 inside the band, smoothstep down to 0 over `softness` degrees past it."""
    diff = np.abs(hue - centre)
    dist = np.minimum(diff, 360.0 - diff)
    if softness <= 0.0:
        return (dist <= half_width).astype(np.float32)
    t = np.clip((dist - half_width) / softness, 0.0, 1.0)
    return (1.0 - t * t * (3.0 - 2.0 * t)).astype(np.float32)


@op(
    "colour_keep",
    label="Colour keep",
    description="Turn everything greyscale except the chosen colours.",
    params=[
        P(
            "keep",
            "color",
            default=_DEFAULT_KEEP,
            label="Keep colour",
            description="The colour to keep. Only its hue counts; pixels with a similar hue stay in colour.",
        ),
        P(
            "hue_range",
            "float",
            min=0.0,
            max=180.0,
            default=20.0,
            step=1.0,
            widget="slider",
            label="Hue range",
            description="Half-width of the kept band, in degrees of hue. Higher keeps more shades around the colour; 180 keeps every hue.",
        ),
        P(
            "softness",
            "float",
            min=0.0,
            max=180.0,
            default=20.0,
            step=1.0,
            widget="slider",
            label="Softness",
            description="Width of the fade past the band, in degrees of hue. Higher gives a gentler edge between colour and grey; 0 is a hard edge.",
        ),
        P(
            "amount",
            "float",
            min=0.0,
            max=1.0,
            default=1.0,
            step=0.05,
            widget="slider",
            label="Amount",
            description="How grey everything outside the band goes. 0 leaves the image unchanged; 1 is full Rec. 709 greyscale.",
        ),
        P(
            "min_saturation",
            "float",
            min=0.0,
            max=1.0,
            default=0.1,
            step=0.01,
            widget="slider",
            label="Minimum saturation",
            description="How colourful a pixel must be to count as kept. Higher turns more dull, near-grey pixels grey; 0 lets every pixel through.",
        ),
        P(
            "use_keep_2",
            "bool",
            default=False,
            label="Second colour",
            description="Keeps a second colour as well. Turn on to use Keep colour 2 and Hue range 2.",
        ),
        P(
            "keep_2",
            "color",
            default=_DEFAULT_KEEP_2,
            disabled_when={"path": "use_keep_2", "equals": False},
            label="Keep colour 2",
            description="The second colour to keep. Only its hue counts.",
        ),
        P(
            "hue_range_2",
            "float",
            min=0.0,
            max=180.0,
            default=20.0,
            step=1.0,
            widget="slider",
            disabled_when={"path": "use_keep_2", "equals": False},
            label="Hue range 2",
            description="Half-width of the second kept band, in degrees of hue. Higher keeps more shades around the colour.",
        ),
    ],
)
def colour_keep(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    hue_range = _clamp(params.get("hue_range", 20.0), 0.0, 180.0, 20.0)
    softness = _clamp(params.get("softness", 20.0), 0.0, 180.0, 20.0)
    amount = _clamp(params.get("amount", 1.0), 0.0, 1.0, 1.0)
    min_sat = _clamp(params.get("min_saturation", 0.1), 0.0, 1.0, 0.1)
    use_2 = bool(params.get("use_keep_2", False))

    out = img.copy()
    if amount <= 0.0:
        return out

    rgb = img[..., :3].astype(np.float64)
    hue = _hue_degrees(rgb.astype(np.float32))

    def centre_of(key: str, fallback: tuple[float, float, float]) -> float:
        swatch = np.array(hex_to_rgb01(params.get(key), fallback), dtype=np.float32)
        return float(_hue_degrees(swatch))

    keep = _band_weight(
        hue, centre_of("keep", _DEFAULT_KEEP_RGB01), hue_range, softness
    )
    if use_2:
        hue_range_2 = _clamp(params.get("hue_range_2", 20.0), 0.0, 180.0, 20.0)
        keep = np.maximum(
            keep,
            _band_weight(
                hue,
                centre_of("keep_2", _DEFAULT_KEEP_2_RGB01),
                hue_range_2,
                softness,
            ),
        )

    if min_sat > 0.0:
        chroma = (rgb.max(axis=-1) - rgb.min(axis=-1)) / 255.0
        lo = 0.5 * min_sat
        t = np.clip((chroma - lo) / (min_sat - lo), 0.0, 1.0)
        keep = keep * (t * t * (3.0 - 2.0 * t)).astype(np.float32)

    # How far each pixel is pulled to grey: the full `amount` outside every
    # band, nothing inside one.
    pull = (amount * (1.0 - keep.astype(np.float64)))[..., None]

    luma = (
        rgb[..., 0] * LUMA_R709 + rgb[..., 1] * LUMA_G709 + rgb[..., 2] * LUMA_B709
    )[..., None]

    blended = rgb + (luma - rgb) * pull
    out[..., :3] = np.clip(blended, 0.0, 255.0).astype(np.uint8)
    return out
