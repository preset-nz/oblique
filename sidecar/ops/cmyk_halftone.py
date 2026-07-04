"""`cmyk_halftone` — screen-printed CMYK dot raster (12-print-toolkit spec).

Aesthetic, not prepress: naive GCR-free separation, classic screen angles,
optional seeded per-channel misregistration. Fully vectorised — per pixel,
the nearest rotated-grid cell centre is computed analytically, ink coverage
is sampled at that centre, and the pixel is inked when it falls inside a
dot of area proportional to coverage (1 px smoothstep edge for AA).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op

# Classic screen angles (degrees): C 15, M 75, Y 0, K 45.
_DEFAULT_ANGLES = {"angle_c": 15.0, "angle_m": 75.0, "angle_y": 0.0, "angle_k": 45.0}

# Ink colours as the RGB channels each ink absorbs: multiplying the working
# RGB by (1 - ink * absorb) is the naive subtractive model.
_ABSORB = {
    "c": np.array([1.0, 0.0, 0.0]),  # cyan absorbs red
    "m": np.array([0.0, 1.0, 0.0]),  # magenta absorbs green
    "y": np.array([0.0, 0.0, 1.0]),  # yellow absorbs blue
    "k": np.array([1.0, 1.0, 1.0]),  # black absorbs everything
}


def _separate(rgb: np.ndarray) -> dict[str, np.ndarray]:
    """RGB [0,1] -> naive CMYK [0,1] (K = 1 - max(rgb), no grey-component tricks)."""
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
) -> np.ndarray:
    """Ink mask [0,1] for one channel: dots on a rotated grid of `pitch` px."""
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
    return t * t * (3.0 - 2.0 * t)


@op(
    "cmyk_halftone",
    label="CMYK Halftone",
    description="Screen-printed CMYK dot raster: classic screen angles with optional seeded misregistration.",
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
        ),
        P("angle_c", "float", min=0.0, max=90.0, default=15.0, step=1.0),
        P("angle_m", "float", min=0.0, max=90.0, default=75.0, step=1.0),
        P("angle_y", "float", min=0.0, max=90.0, default=0.0, step=1.0),
        P("angle_k", "float", min=0.0, max=90.0, default=45.0, step=1.0),
        P(
            "misregistration",
            "float",
            min=0.0,
            max=8.0,
            default=0.0,
            step=0.25,
            scale="spatial",
        ),
        P("seed", "int", min=0, max=2**31 - 1, default=0, step=1),
        P("mode", "enum", default="paper", choices=("paper", "over")),
    ],
)
def cmyk_halftone(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    pitch = max(1.0, float(params.get("dot_size", 6.0)))
    misreg = float(params.get("misregistration", 0.0))
    seed = int(params.get("seed", 0))
    mode = str(params.get("mode", "paper"))

    rgb = img[..., :3].astype(np.float64) / 255.0
    plates = _separate(rgb)

    rng = np.random.default_rng(seed)
    base = rgb if mode == "over" else np.ones_like(rgb)

    out_rgb = base.copy()
    for channel in ("c", "m", "y", "k"):
        angle = float(
            params.get(f"angle_{channel}", _DEFAULT_ANGLES[f"angle_{channel}"])
        )
        # Jitter is drawn per channel even at 0 so the seed stream (and thus
        # every channel's offset) is stable when misregistration is scrubbed.
        jitter = rng.uniform(-1.0, 1.0, size=2) * misreg
        ink = _screen_channel(plates[channel], pitch, angle, (jitter[0], jitter[1]))
        out_rgb *= 1.0 - ink[..., None] * _ABSORB[channel]

    out = img.copy()
    out[..., :3] = np.clip(out_rgb * 255.0, 0.0, 255.0).astype(np.uint8)
    return out
