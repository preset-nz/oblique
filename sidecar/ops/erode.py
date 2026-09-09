"""`erode` — shrink the alpha shape from its edge; RGB untouched. See
`_morphology.py` for the shared implementation and the full contract
this obeys.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import P, op
from ops._morphology import apply_morphology


@op(
    "erode",
    label="Erode",
    description="Eat the layer's shape inward from its edge.",
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
def erode(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    radius = float(params.get("radius", 2.0))
    return apply_morphology(img, radius, grow=False)
