"""`invert` — photographic negative of the RGB channels; alpha untouched."""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import op


@op(
    "invert",
    label="Invert",
    description="Photographic negative of the RGB channels; alpha untouched.",
)
def invert(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    out = img.copy()
    out[..., :3] = 255 - out[..., :3]
    return out
