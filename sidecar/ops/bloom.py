"""`bloom` — bright areas bleed light into their surroundings.

Rec.709 luma marks how far each pixel sits above `threshold`
(`excess`, 0..1, guarded so `threshold -> 1.0` never divides by zero —
`luma01` never exceeds 1, so the guard just collapses to "nothing ever
blooms" rather than producing NaN/inf). The highlight layer is gathered
**premultiplied and alpha-weighted**: `rgb * excess * alpha01` for
colour, `excess * alpha01` for its own alpha. The weighting is not
optional — RGB behind zero alpha is undefined (the same trap
`pixelate.py`'s docstring documents for its own cell average, and
`smear`'s `clip_to_alpha` gate guards against); without it, a wide blur
would smear whatever arbitrary colour sits behind a transparent edge
into the glow. Both channels are blurred with `ops._blur.soften`
(float, separable box-blur) in that premultiplied space, then divided
back apart (`g_rgb`/`g_a`) using the same divide-by-coverage guard
`pixelate.py` uses for its own premultiplied average.

`blend` picks how the glow composites onto the pixels it already
covers: `screen` (default, `255 - (255-orig)*(255-g_rgb*k)/255`, can
only lighten, never wraps) or `add` (`orig + g_rgb*k`, blows out to
white fast; clipped rather than left to wrap — the classic uint8
overflow bug). `k` is `intensity * g_a`, clamped to `[0, 1]` for
`screen` (so `255 - g_rgb*k` can never go negative and flip the blend's
sign) and left unclamped for `add` (the final `[0, 255]` clip is the
only guard it needs).

`spill` decides whether the glow is allowed to extend past the node's
own silhouette into transparent territory — which is what light
actually does off the edge of a cutout, the same reasoning `dilate` and
`edge_noise` already established for growing/moving an alpha boundary.
With `spill` off (default), alpha is byte-identical to the input
everywhere and nothing is written outside the silhouette — the op is a
pure "brighten what's already there" pass. With `spill` on, the glow
additionally composites *under* the original via standard premultiplied
source-over (`a_out = orig_a + glow_contrib_a * (1 - orig_a)`): a
no-op wherever `orig_a` is already 255 (opaque input untouched) and
"glow only" wherever `orig_a` is 0 (pure transparent territory, output
is the blurred glow's own colour and alpha). At partial/antialiased
alpha the same source-over formula applies continuously, so the two
extremes join up smoothly. `writes_alpha=True` is declared
unconditionally (the flag is static per op) because `spill=True` can
grow the silhouette, even though `spill` defaults off.

Pillow can't do this blur: `ImageFilter.GaussianBlur` raises
`ValueError: image has wrong mode` on `"F"`-mode arrays in the pinned
Pillow 12.3.0, and an 8-bit blur bands visibly across a faint, wide
glow's falloff — see `ops/_blur.py`'s module docstring for the float
separable box-blur this op leans on instead.

Draft honesty note: `radius` is `scale="spatial"`, so it pre-scales with
the draft resolution factor like `gaussian_blur`'s own radius — but a
wide, soft glow rendered at 1/8 DRAFT is a coarser approximation of the
full-res blur than a small, sharp one would be, the same "screen ops
skip draft" gap `pixelate.py` and `cmyk_halftone` already document.

Deliberately not here: `tint`. Real halation is red-biased (the classic
lens-flare/film-bloom colour cast); this pass keeps the glow colour tied
to the source's own bright pixels and leaves colour-casting the glow for
a later param.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, op
from ops._blur import soften


@op(
    "bloom",
    category="film",
    label="Bloom",
    description="Bright areas bleed light into their surroundings.",
    writes_alpha=True,
    params=[
        P(
            "threshold",
            "float",
            min=0.0,
            max=1.0,
            default=0.7,
            step=0.01,
            scale="none",
            label="Threshold",
            description="Brightness above which pixels glow, 0 to 1. Lower lets more of the image bloom.",
        ),
        P(
            "radius",
            "float",
            min=0.0,
            max=200.0,
            default=24.0,
            step=0.5,
            scale="spatial",
            label="Radius",
            description="How far the glow spreads, in document pixels. Larger is a wider, softer glow.",
        ),
        P(
            "intensity",
            "float",
            min=0.0,
            max=2.0,
            default=0.8,
            step=0.01,
            scale="none",
            label="Intensity",
            description="Strength of the glow. Higher is brighter; 0 turns it off.",
        ),
        P(
            "blend",
            "enum",
            default="screen",
            choices=("screen", "add"),
            label="Blend",
            description="How the glow combines with the image: screen only lightens, add blows out to white faster.",
        ),
        P(
            "spill",
            "bool",
            default=False,
            label="Glow past edge",
            description="Lets the glow spread beyond the layer's edge into transparent areas.",
        ),
    ],
)
def bloom(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    threshold = float(params.get("threshold", 0.7))
    radius = float(params.get("radius", 24.0))
    intensity = float(params.get("intensity", 0.8))
    blend = str(params.get("blend", "screen"))
    spill = bool(params.get("spill", False))

    out = img.copy()
    if radius <= 0.0 or intensity <= 0.0:
        return out

    orig_rgb = out[..., :3].astype(np.float64)
    orig_a = out[..., 3].astype(np.float64)
    orig_a01 = orig_a / 255.0
    luma01 = (
        LUMA_R709 * orig_rgb[..., 0]
        + LUMA_G709 * orig_rgb[..., 1]
        + LUMA_B709 * orig_rgb[..., 2]
    ) / 255.0

    # Guard threshold -> 1.0 (division by zero).
    denom = max(1.0 - threshold, 1e-6)
    excess = np.clip((luma01 - threshold) / denom, 0.0, 1.0)

    # --- gather the highlight layer, premultiplied and alpha-weighted --
    weight = excess * orig_a01
    glow_rgb_premul = orig_rgb * weight[..., None]
    glow_a = weight

    blurred_rgb_premul = soften(glow_rgb_premul, radius)
    blurred_a = soften(glow_a, radius)

    has_coverage = blurred_a > 1e-8
    safe_a = np.where(has_coverage, blurred_a, 1.0)
    g_rgb = np.where(
        has_coverage[..., None], blurred_rgb_premul / safe_a[..., None], 0.0
    )
    g_a = blurred_a  # already 0..1

    # `strength` doubles as the `screen` blend's clamped multiplier and
    # the spill compositor's own glow alpha (`glow_contrib_a` above) —
    # both are the same `clip(intensity * g_a, 0, 1)` quantity.
    strength = np.clip(intensity * g_a, 0.0, 1.0)
    k_raw = intensity * g_a  # unclamped — `add` relies on the [0, 255] clip instead

    if blend == "add":
        blended_rgb = orig_rgb + g_rgb * k_raw[..., None]
    else:  # screen (default)
        screened = 255.0 - g_rgb * strength[..., None]
        blended_rgb = 255.0 - (255.0 - orig_rgb) * screened / 255.0
    blended_rgb = np.clip(blended_rgb, 0.0, 255.0)

    if not spill:
        silhouette = orig_a > 0
        out_rgb = np.where(silhouette[..., None], blended_rgb, orig_rgb)
        out[..., :3] = np.round(out_rgb).astype(np.uint8)
        return out

    # spill=True: composite the glow *under* the already-blended original
    # via standard premultiplied source-over. Computed directly in 0..255
    # alpha space so `strength == 0` leaves `out_a` exactly `orig_a`, not
    # a 0..1 round-trip approximation of it.
    out_a = orig_a + strength * (255.0 - orig_a)
    out_a01 = out_a / 255.0
    out_premul = (
        blended_rgb * orig_a01[..., None]
        + g_rgb * (strength * (1.0 - orig_a01))[..., None]
    )
    has_out_a = out_a01 > 1e-8
    safe_out_a01 = np.where(has_out_a, out_a01, 1.0)
    out_rgb = np.where(has_out_a[..., None], out_premul / safe_out_a01[..., None], 0.0)

    out[..., :3] = np.round(np.clip(out_rgb, 0.0, 255.0)).astype(np.uint8)
    out[..., 3] = np.round(np.clip(out_a, 0.0, 255.0)).astype(np.uint8)
    return out
