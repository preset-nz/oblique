"""`edge_noise` — seeded roughening of the alpha boundary; the interior
(and exterior) stay untouched. The "torn paper" op — see
`guidance/projects/oblique/features/16-alpha-and-edges/edge-noise.md` and
`design/mask-spill.md` for the full contract.

**Warp the boundary; do not add noise to alpha everywhere.** The naive
add-noise-and-rethreshold approach punches holes in a solid interior and
turns a fully-opaque layer lacy even though it has no edge at all. This
implementation is the story's **warp-the-sampling-coordinates** variant
(the alternative to perturbing alpha values directly), because only a
displacement measured in pixels can move the boundary by "roughly a
full noise cell" at `amount=1`, as the story requires:

1. Builds a smooth, seeded value-noise field at feature size `scale` —
   low-resolution white noise from the seeded RNG, bicubic-upsampled to
   the image size (the same controllable-feature-size trick the story
   prescribes; no noise library in the sidecar). The `profile` param
   picks how that low-res field is turned into the full-size field:
   - `smooth` (default) — bicubic upsample, as above. Byte-identical to
     the pre-`profile` op for every param combination.
   - `linear` — bilinear upsample: "connect the dots". Straight runs
     between noise points with a corner at each, so tears are polygonal
     rather than curved.
   - `rect` — the same low-res field, upsampled with nearest-neighbour
     instead of bicubic, so the boundary steps in flat square blocks.
   - `saw` — the bicubic-upsampled field folded into a ridge/triangle
     wave (`1 - 2*abs(v)`), which turns smooth wander into sharp,
     regularly-spaced teeth.
   - `straight` — nearest-neighbour upsample of a *coarser* field (3x
     the normal cell size), giving a few large flat displacements —
     long straight rips with hard corners rather than fine texture.
2. Softens alpha with a box-blur radius of `max(1, amount * scale)` px
   — wide enough that the resulting gradient band covers every pixel a
   displacement of up to `amount * scale` px could reach — then takes
   the gradient of that softened alpha as the boundary normal, and its
   normalised magnitude as a 0..1 weight. Both are ~0 in the solid
   interior and the empty exterior (weight `max`-normalises to 0 there
   too), and non-zero across the transition band.
3. Displaces each pixel's sampling coordinate along that normal by
   `noise * amount * scale * weight` px, and bilinearly samples the
   *original* (un-softened) alpha there. RGB is never touched.

A fully-opaque or fully-transparent input has zero gradient everywhere,
so the displacement is zero everywhere and the op returns an exact copy.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op
from ops._blur import soften as _soften
from ops._noise import noise_field as _noise_field
from ops._warp import bilinear_sample as _bilinear_sample


@op(
    "edge_noise",
    label="Edge Noise",
    description="Tear and crumble the layer's edge — the interior stays solid.",
    writes_alpha=True,
    params=[
        P(
            "amount",
            "float",
            min=0.0,
            max=1.0,
            default=0.4,
            step=0.01,
            scale="none",
            label="Amount",
            description="How far the edge is pushed around, as a proportion of Feature size. Higher is rougher; 0 does nothing.",
        ),
        P(
            "scale",
            "float",
            min=1.0,
            max=128.0,
            default=12.0,
            step=0.5,
            scale="spatial",
            label="Feature size",
            description="Size of the bumps along the edge, in document pixels. Larger is broader tears.",
        ),
        P(
            "seed",
            "int",
            min=0,
            max=2**31 - 1,
            default=0,
            step=1,
            scale="none",
            label="Seed",
            description="Changes the random pattern without changing its character.",
        ),
        P(
            "profile",
            "enum",
            default="smooth",
            choices=("smooth", "linear", "saw", "rect", "straight"),
            label="Profile",
            description="Shape of the tears: smooth curves, linear (polygonal), saw (sharp teeth), rect (square steps) or straight (long flat rips).",
        ),
    ],
)
def edge_noise(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    amount = float(params.get("amount", 0.4))
    scale = max(1e-6, float(params.get("scale", 12.0)))
    seed = int(params.get("seed", 0))
    profile = str(params.get("profile", "smooth"))

    out = img.copy()
    if amount <= 0.0:
        return out

    h, w = out.shape[:2]
    alpha_f = out[..., 3].astype(np.float64)
    alpha01 = alpha_f / 255.0

    # --- boundary normal + closeness weight, from softened alpha -------
    # Soften wide enough that every pixel a displacement of up to
    # amount*scale px could reach sees a non-zero gradient.
    soften_radius = max(1.0, amount * scale)
    alpha_soft = _soften(alpha01, soften_radius)

    gy, gx = np.gradient(alpha_soft)
    grad_mag = np.sqrt(gy * gy + gx * gx)

    max_grad = float(grad_mag.max())
    if max_grad <= 1e-9:
        # No alpha edge anywhere (fully opaque or fully transparent) —
        # the op must be a no-op.
        return out
    weight = grad_mag / max_grad

    safe_mag = np.where(grad_mag > 1e-9, grad_mag, 1.0)
    normal_y = np.where(grad_mag > 1e-9, gy / safe_mag, 0.0)
    normal_x = np.where(grad_mag > 1e-9, gx / safe_mag, 0.0)

    # --- seeded value-noise field, feature size `scale` -----------------
    noise_full = _noise_field(h, w, scale, seed, profile)

    displacement = noise_full * amount * scale * weight
    dy = displacement * normal_y
    dx = displacement * normal_x

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    sample_y = yy - dy
    sample_x = xx - dx

    new_alpha = np.clip(_bilinear_sample(alpha_f, sample_y, sample_x), 0.0, 255.0)
    out[..., 3] = np.round(new_alpha).astype(np.uint8)

    return out
