"""`dilate` — grow the alpha shape outward, RGB carried by nearest-opaque
colour. See `_morphology.py` for the shared implementation and the full
contract this obeys.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op
from ops._morphology import apply_morphology


@op(
    "dilate",
    label="Dilate",
    description="Grow the layer's shape outward, carrying its edge colour with it.",
    writes_alpha=True,
    params=[
        P(
            "radius",
            "float",
            min=0.0,
            max=64.0,
            default=2.0,
            step=0.5,
            scale="spatial",
        ),
    ],
)
def dilate(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    radius = float(params.get("radius", 2.0))
    return apply_morphology(img, radius, grow=True)
