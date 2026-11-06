"""`gaussian_blur` — Pillow `GaussianBlur` on RGB only; alpha untouched.

Radius is authored in document pixels; the client pre-scales it by the
resolution factor (draft 1/8, working 1/2, full 1) before sending, so
preview levels look the same on screen (`scale: "spatial"` below).

With a radius driver attached (Epic 27 story 1) the radius follows a layer:
each pixel is blurred by plane x radius, white meaning the full radius and
black sharp. That path is `ops/_driven_blur.py` (the maths and the NumPy
reference) running the Rust kernel `oblique_kernels.driven_blur`.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from ops import D, P, _kernels, op
from ops._driven_blur import build_spec, driven_blur_reference


@op(
    "gaussian_blur",
    category="distort",
    label="Gaussian Blur",
    description="Even, soft blur across the RGB channels — alpha stays untouched.",
    params=[
        P(
            "radius",
            "float",
            min=0.0,
            max=100.0,
            default=4.0,
            step=0.1,
            scale="spatial",
            label="Radius",
            description="Blur radius in document pixels. Larger is softer; 0 does nothing.",
        ),
    ],
    drivers=[
        D(
            "radius",
            label="Blur follows a layer",
            description=(
                "The blur radius follows a layer: the full radius where it is white, "
                "sharp where it is black. A depth map, inverted, blurs the distance."
            ),
        )
    ],
)
def gaussian_blur(
    img: np.ndarray,
    params: dict[str, Any],
    drivers: dict[str, np.ndarray] | None = None,
) -> np.ndarray:
    radius = float(params.get("radius", 4.0))

    out = img.copy()
    if radius <= 0.0:
        return out

    plane = drivers.get("radius") if drivers else None
    if plane is not None:
        # The plane is k/255 in float32; rint(plane * 255) gives k back exactly.
        v = np.rint(plane * np.float32(255.0)).astype(np.uint8)
        rgb8 = np.ascontiguousarray(out[..., :3])
        spec = build_spec(radius)
        if _kernels.available():
            out[..., :3] = _kernels.require().driven_blur(rgb8, v, spec)
        else:  # the reference: same bytes, minutes at real sizes
            out[..., :3] = driven_blur_reference(rgb8, v, spec)
        return out

    rgb = Image.fromarray(out[..., :3], mode="RGB")
    blurred = rgb.filter(ImageFilter.GaussianBlur(radius=radius))
    out[..., :3] = np.asarray(blurred, dtype=np.uint8)
    return out
