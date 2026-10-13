"""`smear` — the scanner head stalled: sample one pixel row or column and
repeat it across the frame.

`direction` picks the axis the smear **runs along**, same convention as
`ink_starved` (`sidecar/ops/ink_starved.py`): `h` samples a *column* at
`position` and repeats it left/right across x; `v` samples a *row* and
repeats it up/down along y. `position` (0..1) is normalised along the
sampled axis — `index = round(position * (axis_len - 1))`, clamped into
range — so it is resolution-independent by construction (`scale="none"`,
unlike the grid ops such as `pixelate`/`cmyk_halftone` that lose their
footing at low-res draft).

`mode` decides which side of the sampled line gets overwritten:
`forward` (increasing coordinate — right for `h`, down for `v`) leaves
everything *before* the line untouched and turns everything at or after
it into the line; `backward` is the mirror; `both` replaces the entire
frame with the sampled line, so nothing of the original survives. That
last one is the confirmed intent — a head that's *really* stalled paints
the whole frame from one line, not most of it.

`clip_to_alpha` (default off) confines the smear to the silhouette the
node already covered: where the original pixel's alpha was 0, nothing is
written at all (colour or alpha); where it was > 0, only RGB is
overwritten with the sampled colour and the original alpha value is left
standing. The gate is two-sided — a *sampled* pixel that is itself fully
transparent carries no meaningful colour (RGB behind zero alpha is
whatever was last left there, usually black), so it is skipped rather
than painted into the silhouette as a black band. With `clip_to_alpha` off, the sampled line's alpha travels with
its colour everywhere the smear writes — including into previously
transparent territory, extending or replacing the silhouette outright.
That's why this op declares `writes_alpha=True`: leaving alpha at
original-resolution detail behind smeared colour is exactly the
flat-colour-behind-a-crisp-silhouette pathology `pixelate.py`'s docstring
warns about.

Draft honesty note: like `pixelate`, `position` survives DRAFT resolution
intact (it's normalised, not a pixel count) — but the sampled row/column
itself is still whatever DRAFT decimated it down to, so the smeared
colour at 1/8 DRAFT won't match full-res exactly. Known, not fixed here.

Deliberately not here: `falloff`. A stalled scanner usually decays rather
than running dead-flat all the way to the edge — that's next backlog
turn, not an oversight in this pass.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op


@op(
    "smear",
    label="Smear",
    description="The scanner head stalled: sample one row or column and repeat it across the frame.",
    writes_alpha=True,
    params=[
        P(
            "direction",
            "enum",
            default="h",
            choices=("h", "v"),
            label="Direction",
            description="h repeats a sampled column sideways; v repeats a sampled row up and down.",
        ),
        P(
            "mode",
            "enum",
            default="forward",
            choices=("forward", "both", "backward"),
            label="Mode",
            description="Which side of the sampled line is overwritten: forward (right or down), backward (left or up), or both (the whole frame).",
        ),
        P(
            "position",
            "float",
            min=0.0,
            max=1.0,
            default=0.5,
            step=0.01,
            scale="none",
            label="Position",
            description="Where the sampled column or row sits, from 0 (left or top) to 1 (right or bottom).",
        ),
        P(
            "clip_to_alpha",
            "bool",
            default=False,
            label="Keep silhouette",
            description="Only recolours pixels that are already visible, so the shape's outline does not change.",
        ),
    ],
)
def smear(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    direction = str(params.get("direction", "h"))
    mode = str(params.get("mode", "forward"))
    position = float(params.get("position", 0.5))
    clip_to_alpha = bool(params.get("clip_to_alpha", False))

    h, w = img.shape[:2]
    out = img.copy()

    axis_len = w if direction == "h" else h
    idx = round(position * (axis_len - 1))
    idx = max(0, min(axis_len - 1, idx))

    if direction == "h":
        sample = img[:, idx, :]  # (h, 4) — the stalled column
        if mode == "both":
            lo, hi = 0, w
        elif mode == "forward":
            lo, hi = idx, w
        else:  # backward
            lo, hi = 0, idx + 1
        region = (slice(None), slice(lo, hi))
        sampled_block = np.broadcast_to(sample[:, None, :], (h, hi - lo, 4))
    else:
        sample = img[idx, :, :]  # (w, 4) — the stalled row
        if mode == "both":
            lo, hi = 0, h
        elif mode == "forward":
            lo, hi = idx, h
        else:  # backward
            lo, hi = 0, idx + 1
        region = (slice(lo, hi), slice(None))
        sampled_block = np.broadcast_to(sample[None, :, :], (hi - lo, w, 4))

    if clip_to_alpha:
        # Confine to the existing silhouette: only overwrite RGB where the
        # original pixel was already non-transparent, and leave alpha
        # exactly as it was — the smear can darken/lighten what's there
        # but never grows or erases the shape.
        orig_block = img[region]
        # Two-sided gate: the destination must already be part of the
        # silhouette, and the sampled pixel must carry real colour. RGB
        # behind zero alpha is undefined, so smearing it into an opaque
        # destination would paint arbitrary (usually black) bands.
        write = (orig_block[..., 3] > 0) & (sampled_block[..., 3] > 0)
        # `out[region]` is a view (basic slicing) straight into `out`, so
        # writing through the `[..., :3]` sub-view mutates `out` in place —
        # no re-assignment needed, and alpha in `region` stays whatever the
        # initial `img.copy()` already put there.
        out[region][..., :3][write] = sampled_block[..., :3][write]
    else:
        # Sampled alpha travels with its colour across the whole region —
        # can extend into or erase transparency, per the op contract.
        out[region] = sampled_block

    return out
