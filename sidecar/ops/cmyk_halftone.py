"""`cmyk_halftone` — screen-printed CMYK dot raster with swappable inks
(12-print-toolkit spec).

Aesthetic, not prepress: naive GCR-free separation, classic screen angles,
optional seeded per-channel misregistration, printed in whatever four ink
colours you choose. Fully vectorised — per pixel, the nearest rotated-grid
cell centre is computed analytically, ink coverage is sampled at that
centre, and the pixel is inked when it falls inside a dot of area
proportional to coverage (1 px smoothstep edge for AA).

Separation is process, inks are yours: `_separate()` always splits the
image into four naive CMYK plates — that half is prepress and untouchable.
What colour each plate is *printed in* is a separate, purely aesthetic
choice (`ink_c`/`ink_m`/`ink_y`/`ink_k`), which is exactly how a real
spot-ink misprint looks.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, hex_to_rgb01, op

# Classic screen angles (degrees): C 15, M 75, Y 0, K 45.
_DEFAULT_ANGLES = {"angle_c": 15.0, "angle_m": 75.0, "angle_y": 0.0, "angle_k": 45.0}

# Ink colours as hex, the colour each plate is *printed in*. Process CMYK by
# default. Kept as one table so the param defaults and their `params.get`
# fallbacks cannot drift apart — mirrors how `_DEFAULT_ANGLES` backs the
# angle params above.
_DEFAULT_INKS = {
    "c": "#00ffff",
    "m": "#ff00ff",
    "y": "#ffff00",
    "k": "#000000",
}
# The fallback arg here is never used in practice — every value above is a
# valid hex string — but `hex_to_rgb01` requires one.
_DEFAULT_INKS_RGB01 = {
    channel: hex_to_rgb01(hexval, (0.0, 0.0, 0.0))
    for channel, hexval in _DEFAULT_INKS.items()
}


def _separate(rgb: np.ndarray) -> dict[str, np.ndarray]:
    """RGB [0,1] -> naive CMYK [0,1] (K = 1 - max(rgb), no grey-component
    tricks). Separation is process CMYK, full stop — ink colour is a
    downstream, purely aesthetic concern applied by the caller."""
    k = 1.0 - rgb.max(axis=-1)
    denom = np.maximum(1.0 - k, 1e-6)
    c = (1.0 - rgb[..., 0] - k) / denom
    m = (1.0 - rgb[..., 1] - k) / denom
    y = (1.0 - rgb[..., 2] - k) / denom
    return {"c": c, "m": m, "y": y, "k": k}


def _screen_channel(
    coverage: np.ndarray,
    pitch: float,
    angle_deg: float,
    offset: tuple[float, float],
    skip_empty: bool = False,
) -> np.ndarray:
    """Ink mask [0,1] for one channel: dots on a rotated grid of `pitch` px.

    `skip_empty` drops the dot of any cell whose sampled coverage is exactly
    zero. Off by default (the long-standing look: a zero-coverage cell still
    leaves a one-pixel speck at its centre, which `spill` can't tolerate —
    it writes coverage as alpha, so specks would pepper all of the
    transparent area around the layer)."""
    h, w = coverage.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    xs += offset[0]
    ys += offset[1]

    theta = np.deg2rad(angle_deg)
    cos_t, sin_t = np.cos(theta), np.sin(theta)

    # Rotate into screen space, find each pixel's nearest cell centre.
    u = (xs * cos_t + ys * sin_t) / pitch
    v = (-xs * sin_t + ys * cos_t) / pitch
    cu, cv = np.round(u), np.round(v)

    # Cell centre back in image space, clamped for the coverage lookup.
    cx = (cu * cos_t - cv * sin_t) * pitch - offset[0]
    cy = (cu * sin_t + cv * cos_t) * pitch - offset[1]
    ix = np.clip(np.round(cx), 0, w - 1).astype(np.intp)
    iy = np.clip(np.round(cy), 0, h - 1).astype(np.intp)
    cell_coverage = coverage[iy, ix]

    # Dot area == coverage * cell area -> radius in px; slight overdrive so
    # full coverage closes the gaps between circles on the square grid.
    radius = pitch * np.sqrt(np.maximum(cell_coverage, 0.0) / np.pi) * 1.08

    dist = np.hypot((u - cu) * pitch, (v - cv) * pitch)
    # 1 px smoothstep edge: ink 1 inside radius-0.5, 0 outside radius+0.5.
    t = np.clip((radius - dist + 0.5), 0.0, 1.0)
    ink = t * t * (3.0 - 2.0 * t)
    if skip_empty:
        ink = np.where(cell_coverage > 0.0, ink, 0.0)
    return ink


@op(
    "cmyk_halftone",
    label="CMYK Halftone",
    description=(
        "Prints the picture as the four dot screens of CMYK, at the classic "
        "angles, with optional misregistration and inks you can swap for "
        "spot-colour and riso looks."
    ),
    params=[
        # Dogfood fix (Epic 04 stack-rows): the original max=32.0 was a
        # guess that was too timid — chunky poster-scale halftones want a
        # much bigger dot pitch. Raised outright (hard max), rather than
        # relying on the UI's soft-max/typed-overflow behaviour, since a
        # spatial-scale param this size-sensitive deserves an honest range.
        P(
            "dot_size",
            "float",
            min=1.0,
            max=200.0,
            default=6.0,
            step=0.5,
            scale="spatial",
            label="Dot size",
            description="Spacing between dot centres in document pixels. Larger is coarser dots.",
        ),
        P(
            "angle_c",
            "float",
            min=0.0,
            max=90.0,
            default=15.0,
            step=1.0,
            label="Cyan angle",
            description="Rotation of the cyan dot screen in degrees.",
        ),
        P(
            "angle_m",
            "float",
            min=0.0,
            max=90.0,
            default=75.0,
            step=1.0,
            label="Magenta angle",
            description="Rotation of the magenta dot screen in degrees.",
        ),
        P(
            "angle_y",
            "float",
            min=0.0,
            max=90.0,
            default=0.0,
            step=1.0,
            label="Yellow angle",
            description="Rotation of the yellow dot screen in degrees.",
        ),
        P(
            "angle_k",
            "float",
            min=0.0,
            max=90.0,
            default=45.0,
            step=1.0,
            label="Black angle",
            description="Rotation of the black dot screen in degrees.",
        ),
        P(
            "ink_c",
            "color",
            default=_DEFAULT_INKS["c"],
            label="Cyan ink",
            description="Colour the cyan plate is printed in.",
        ),
        P(
            "ink_m",
            "color",
            default=_DEFAULT_INKS["m"],
            label="Magenta ink",
            description="Colour the magenta plate is printed in.",
        ),
        P(
            "ink_y",
            "color",
            default=_DEFAULT_INKS["y"],
            label="Yellow ink",
            description="Colour the yellow plate is printed in.",
        ),
        P(
            "ink_k",
            "color",
            default=_DEFAULT_INKS["k"],
            label="Black ink",
            description="Colour the black plate is printed in.",
        ),
        P(
            "misregistration",
            "float",
            min=0.0,
            max=8.0,
            default=0.0,
            step=0.25,
            scale="spatial",
            label="Misregistration",
            description="Largest random shift of each ink plate, in document pixels. 0 keeps the plates aligned.",
        ),
        P(
            "seed",
            "int",
            min=0,
            max=2**31 - 1,
            default=0,
            step=1,
            label="Seed",
            description="Changes the random pattern without changing its character.",
        ),
        P(
            "mode",
            "enum",
            default="paper",
            choices=("paper", "over"),
            label="Mode",
            description="paper prints the dots on white paper; over prints them on top of the original image.",
        ),
        P(
            "white_is_alpha",
            "bool",
            default=False,
            label="Paper is transparent",
            description="Makes the paper transparent so the dots overprint the layers below. Paper mode only.",
        ),
        # Only effective with `white_is_alpha` in paper mode. The panel's
        # `disabled_when` takes a single condition, so it greys out on
        # `white_is_alpha` only; the paper-mode half is enforced in the cook
        # (with mode='over' it is silently ignored).
        P(
            "spill",
            "bool",
            default=False,
            disabled_when={"path": "white_is_alpha", "equals": False},
            label="Dots past edge",
            description="Samples the dots from the layer's tone over paper, so they carry on past its edge. Needs Paper is transparent, in paper mode.",
        ),
    ],
    writes_alpha=True,
)
def cmyk_halftone(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    pitch = max(1.0, float(params.get("dot_size", 6.0)))
    misreg = float(params.get("misregistration", 0.0))
    seed = int(params.get("seed", 0))
    mode = str(params.get("mode", "paper"))
    white_is_alpha = bool(params.get("white_is_alpha", False)) and mode == "paper"

    spill = white_is_alpha and bool(params.get("spill", False))

    rgb = img[..., :3].astype(np.float64) / 255.0
    if spill:
        # Transparent means paper, not "black from canvas readback": flatten
        # over paper white so no-alpha pixels carry no ink.
        in_a = img[..., 3:4].astype(np.float64) / 255.0
        rgb = rgb * in_a + (1.0 - in_a)
    plates = _separate(rgb)

    # Subtractive ink model: absorption is 1 - the ink's own RGB. Computed
    # once before the loop — cheap regardless, but it keeps the loop body
    # about screening, not parsing.
    absorb = {
        channel: 1.0
        - np.array(
            hex_to_rgb01(
                params.get(f"ink_{channel}", _DEFAULT_INKS[channel]),
                _DEFAULT_INKS_RGB01[channel],
            )
        )
        for channel in ("c", "m", "y", "k")
    }

    rng = np.random.default_rng(seed)
    base = rgb if mode == "over" else np.ones_like(rgb)

    out_rgb = base.copy()
    coverage = np.zeros(rgb.shape[:2], dtype=np.float64)
    for channel in ("c", "m", "y", "k"):
        angle = float(
            params.get(f"angle_{channel}", _DEFAULT_ANGLES[f"angle_{channel}"])
        )
        # Jitter is drawn per channel even at 0 so the seed stream (and thus
        # every channel's offset) is stable when misregistration is scrubbed.
        jitter = rng.uniform(-1.0, 1.0, size=2) * misreg
        ink = _screen_channel(
            plates[channel], pitch, angle, (jitter[0], jitter[1]), skip_empty=spill
        )
        out_rgb *= 1.0 - ink[..., None] * absorb[channel]
        coverage = 1.0 - (1.0 - coverage) * (1.0 - ink)

    out = img.copy()

    if white_is_alpha:
        # `out_rgb` is the ink colour already mixed with the white paper at
        # partial coverage; un-blend it so the compositor (which reads
        # non-premultiplied RGB) doesn't see a washed-out colour at dot
        # edges. Pixels at ~zero coverage have unobservable ink colour —
        # fill with paper white and never divide by ~0.
        safe_coverage = np.maximum(coverage, 1e-6)
        ink_rgb = (out_rgb - (1.0 - coverage[..., None])) / safe_coverage[..., None]
        ink_rgb = np.where(coverage[..., None] < 1e-6, 1.0, ink_rgb)
        ink_rgb = np.clip(ink_rgb, 0.0, 1.0)

        out[..., :3] = np.clip(ink_rgb * 255.0, 0.0, 255.0).astype(np.uint8)
        if spill:
            # The silhouette is the tone the dots are sampled from, not a
            # cookie cutter: alpha is coverage alone.
            out_alpha = coverage
        else:
            in_alpha = img[..., 3].astype(np.float64) / 255.0
            out_alpha = in_alpha * coverage
        out[..., 3] = np.clip(np.round(out_alpha * 255.0), 0.0, 255.0).astype(np.uint8)
    else:
        out[..., :3] = np.clip(out_rgb * 255.0, 0.0, 255.0).astype(np.uint8)

    return out
