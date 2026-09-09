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
   prescribes; no noise library in the sidecar).
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
from PIL import Image

from ops import P, op


def _box_blur_1d(arr: np.ndarray, axis: int, radius: int) -> np.ndarray:
    """Edge-padded box blur along one axis, `radius` px each side."""
    if radius <= 0:
        return arr
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (radius, radius)
    padded = np.pad(arr, pad, mode="edge")
    n = 2 * radius + 1
    cumsum = np.cumsum(padded, axis=axis)
    zeros_shape = list(cumsum.shape)
    zeros_shape[axis] = 1
    cumsum = np.concatenate(
        [np.zeros(zeros_shape, dtype=cumsum.dtype), cumsum], axis=axis
    )
    size = arr.shape[axis]
    sl_hi = [slice(None)] * arr.ndim
    sl_hi[axis] = slice(n, n + size)
    sl_lo = [slice(None)] * arr.ndim
    sl_lo[axis] = slice(0, size)
    return (cumsum[tuple(sl_hi)] - cumsum[tuple(sl_lo)]) / n


def _soften(arr: np.ndarray, radius: float) -> np.ndarray:
    """Cheap 3-pass box blur (approximates a Gaussian) at `radius` px,
    applied separably. Plain NumPy — no `scipy` in the sidecar."""
    r = max(1, int(round(radius)))
    out = arr
    for _ in range(3):
        out = _box_blur_1d(out, axis=0, radius=r)
        out = _box_blur_1d(out, axis=1, radius=r)
    return out


def _bilinear_sample(arr: np.ndarray, ys: np.ndarray, xs: np.ndarray) -> np.ndarray:
    """Bilinearly sample 2D float `arr` at fractional coordinates `ys`,
    `xs` (same shape as `arr`), clamped to the canvas edges."""
    h, w = arr.shape
    ys = np.clip(ys, 0.0, h - 1.0)
    xs = np.clip(xs, 0.0, w - 1.0)

    y0 = np.floor(ys).astype(np.int64)
    x0 = np.floor(xs).astype(np.int64)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)

    fy = ys - y0
    fx = xs - x0

    top = arr[y0, x0] * (1.0 - fx) + arr[y0, x1] * fx
    bottom = arr[y1, x0] * (1.0 - fx) + arr[y1, x1] * fx
    return top * (1.0 - fy) + bottom * fy


@op(
    "edge_noise",
    label="Edge Noise",
    description="Tear and crumble the layer's edge — the interior stays solid.",
    writes_alpha=True,
    params=[
        P("amount", "float", min=0.0, max=1.0, default=0.4, step=0.01, scale="none"),
        P(
            "scale",
            "float",
            min=1.0,
            max=128.0,
            default=12.0,
            step=0.5,
            scale="spatial",
        ),
        P("seed", "int", min=0, max=2**31 - 1, default=0, step=1, scale="none"),
    ],
)
def edge_noise(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    amount = float(params.get("amount", 0.4))
    scale = max(1e-6, float(params.get("scale", 12.0)))
    seed = int(params.get("seed", 0))

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
    rng = np.random.default_rng(seed)
    small_h = max(1, int(round(h / scale)))
    small_w = max(1, int(round(w / scale)))
    noise_small = rng.uniform(-1.0, 1.0, size=(small_h, small_w)).astype(np.float32)
    noise_img = Image.fromarray(noise_small, mode="F")
    noise_full = np.asarray(
        noise_img.resize((w, h), resample=Image.BICUBIC), dtype=np.float64
    )

    displacement = noise_full * amount * scale * weight
    dy = displacement * normal_y
    dx = displacement * normal_x

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    sample_y = yy - dy
    sample_x = xx - dx

    new_alpha = np.clip(_bilinear_sample(alpha_f, sample_y, sample_x), 0.0, 255.0)
    out[..., 3] = np.round(new_alpha).astype(np.uint8)

    return out
