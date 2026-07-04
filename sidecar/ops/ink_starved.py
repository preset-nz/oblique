"""`ink_starved` — the printer running dry: ink coverage fades along one
axis as the cartridge empties, with periodic density stripes from a
worn roller and (in the single-channel variants) a naive CMYK separation
so you can starve just the cyan, or just the black. RGBA in/out at the
same size, alpha untouched.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op

_CHANNEL_ABSORB = {
    # Same naive subtractive model as cmyk_halftone: starving a plate means
    # its absorption weakens, so the colour it normally removes creeps back.
    "c": np.array([1.0, 0.0, 0.0]),
    "m": np.array([0.0, 1.0, 0.0]),
    "y": np.array([0.0, 0.0, 1.0]),
    "k": np.array([1.0, 1.0, 1.0]),
}


def _separate(rgb: np.ndarray) -> dict[str, np.ndarray]:
    """RGB [0,1] -> naive CMYK [0,1] (K = 1 - max(rgb))."""
    k = 1.0 - rgb.max(axis=-1)
    denom = np.maximum(1.0 - k, 1e-6)
    c = (1.0 - rgb[..., 0] - k) / denom
    m = (1.0 - rgb[..., 1] - k) / denom
    y = (1.0 - rgb[..., 2] - k) / denom
    return {"c": c, "m": m, "y": y, "k": k}


@op(
    "ink_starved",
    params=[
        P("direction", "enum", default="h", choices=("h", "v")),
        P("starvation", "float", min=0.0, max=1.0, default=0.4, step=0.01),
        P("banding", "float", min=0.0, max=1.0, default=0.2, step=0.01),
        P(
            "banding_period",
            "float",
            min=2.0,
            max=64.0,
            default=12.0,
            step=1.0,
            scale="spatial",
        ),
        P(
            "channel",
            "enum",
            default="all",
            choices=("all", "c", "m", "y", "k"),
        ),
        P("seed", "int", min=0, max=2**31 - 1, default=0, step=1),
    ],
)
def ink_starved(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    direction = str(params.get("direction", "h"))
    starvation = float(params.get("starvation", 0.4))
    banding = float(params.get("banding", 0.2))
    channel = str(params.get("channel", "all"))
    seed = int(params.get("seed", 0))

    h, w = img.shape[:2]
    rng = np.random.default_rng(seed)

    axis_len = w if direction == "h" else h
    # Fade gradient: full ink at the start of the run, starved toward the
    # end. `starvation` is the fraction of the run that goes dry.
    ramp = np.linspace(0.0, 1.0, axis_len)
    fade = np.clip(1.0 - starvation * ramp, 0.0, 1.0)

    # Periodic density stripes from a worn roller, seeded phase so repeat
    # applications (or per-node variation) don't all band identically.
    if banding > 0.0:
        period = max(2.0, float(params.get("banding_period", 12.0)))
        period *= float(rng.uniform(0.85, 1.15))  # seeded wobble, not the scale
        phase = float(rng.uniform(0.0, 2.0 * np.pi))
        stripe = 0.5 + 0.5 * np.sin(2.0 * np.pi * np.arange(axis_len) / period + phase)
        fade = fade * (1.0 - banding * (1.0 - stripe))

    fade = np.clip(fade, 0.0, 1.0)
    coverage = fade[None, :] if direction == "h" else fade[:, None]
    coverage = np.broadcast_to(coverage, (h, w)).astype(np.float64)

    rgb = img[..., :3].astype(np.float64) / 255.0

    if channel == "all":
        # Ink fades toward paper (white) uniformly across channels.
        out_rgb = rgb * coverage[..., None] + (1.0 - coverage[..., None])
    else:
        # Rebuild the image from its four naive CMYK plates, starving only
        # the selected plate's coverage — the others print at full strength
        # (bounded compositing, no division-by-near-zero fragility).
        plates = _separate(rgb)
        out_rgb = np.ones_like(rgb)
        for plate_name in ("c", "m", "y", "k"):
            ink = plates[plate_name]
            if plate_name == channel:
                ink = ink * coverage
            out_rgb *= 1.0 - ink[..., None] * _CHANNEL_ABSORB[plate_name]
        out_rgb = np.clip(out_rgb, 0.0, 1.0)

    out = img.copy()
    out[..., :3] = np.clip(out_rgb * 255.0, 0.0, 255.0).astype(np.uint8)
    return out
