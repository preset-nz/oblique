"""`recolour` — luminance-indexed remap onto an ordered ramp, the
duotone/tritone workhorse. Rec. 709 luma (`ops.LUMA_R709` etc., the same
weights `desaturate`/`xerox`/`colourise` use) becomes a position `t` in
`[0, 1]`, then each channel is a piecewise-linear interpolation across the
`stops` active colours placed at even positions (`stops=3` -> stops at
0.0, 0.5, 1.0). Alpha untouched.

**Why four fixed stops (`stop_1`..`stop_4`) and not an ordered colour
list.** An ordered colour-*list* param needs a list field kind that
doesn't exist yet in the registry contract (see the epic's "Explicitly
out of scope" and `convert_to_index`/`palette_map` in the ops backlog).
Four named colour params ship today with zero new plumbing and cover
every ramp actually requested so far (duotone, tritone, quad). When the
colour-list kind lands, `recolour` is its first migration target — this
is a deliberate v1 shape, not an oversight.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, hex_to_rgb01, op

_STOP_DEFAULTS = ("#000000", "#4a3f6b", "#b06a4a", "#ffffff")
# Fallback tuples live at module scope, one per stop, so a garbled colour
# string for any given stop falls back to that stop's own documented
# default rather than to another stop's colour or to black.
_STOP_DEFAULTS_RGB01 = tuple(
    hex_to_rgb01(hexval, (0.0, 0.0, 0.0)) for hexval in _STOP_DEFAULTS
)


@op(
    "recolour",
    label="Recolour",
    description="Remap luminance onto an ordered 2-4 colour ramp — the duotone/tritone workhorse.",
    params=[
        P("stop_1", "color", default=_STOP_DEFAULTS[0]),
        P("stop_2", "color", default=_STOP_DEFAULTS[1]),
        P("stop_3", "color", default=_STOP_DEFAULTS[2]),
        P("stop_4", "color", default=_STOP_DEFAULTS[3]),
        P("stops", "int", min=2, max=4, default=2, step=1),
        P(
            "blend",
            "float",
            min=0.0,
            max=1.0,
            default=1.0,
            step=0.05,
            widget="slider",
        ),
        P("preserve_luma", "bool", default=False),
    ],
)
def recolour(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    blend = max(0.0, min(1.0, float(params.get("blend", 1.0))))

    out = img.copy()
    if blend <= 0.0:
        return out

    stops = max(2, min(4, int(params.get("stops", 2))))
    preserve_luma = bool(params.get("preserve_luma", False))

    stop_colours01 = [
        hex_to_rgb01(
            params.get(f"stop_{i + 1}", _STOP_DEFAULTS[i]), _STOP_DEFAULTS_RGB01[i]
        )
        for i in range(stops)
    ]
    stop_colours = np.array(stop_colours01, dtype=np.float64) * 255.0  # (stops, 3)
    positions = np.linspace(0.0, 1.0, stops)

    rgb = img[..., :3].astype(np.float64)
    src_luma = (
        rgb[..., 0] * LUMA_R709 + rgb[..., 1] * LUMA_G709 + rgb[..., 2] * LUMA_B709
    )
    t = src_luma / 255.0

    remapped = np.empty((*t.shape, 3), dtype=np.float64)
    for c in range(3):
        remapped[..., c] = np.interp(t, positions, stop_colours[:, c])

    if preserve_luma:
        remapped_luma = (
            remapped[..., 0] * LUMA_R709
            + remapped[..., 1] * LUMA_G709
            + remapped[..., 2] * LUMA_B709
        )
        scale = np.ones_like(remapped_luma)
        safe = remapped_luma > 1e-6
        scale[safe] = src_luma[safe] / remapped_luma[safe]
        remapped = np.clip(remapped * scale[..., None], 0.0, 255.0)

    blended = rgb + (remapped - rgb) * blend
    out[..., :3] = np.clip(blended, 0.0, 255.0).astype(np.uint8)
    return out
