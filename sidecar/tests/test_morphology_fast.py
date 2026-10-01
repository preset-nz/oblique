"""The row-decomposed disc filter must match the per-offset reference exactly."""

from __future__ import annotations

import numpy as np
import pytest

from ops._morphology import _disc_offsets, _filter_disc


def _reference(arr: np.ndarray, radius: int, mode: str) -> np.ndarray:
    if radius <= 0:
        return arr.copy()
    pad_width = [(radius, radius), (radius, radius)] + [(0, 0)] * (arr.ndim - 2)
    padded = np.pad(arr, pad_width, mode="edge")
    h, w = arr.shape[:2]
    acc = None
    for dy, dx in _disc_offsets(radius):
        shifted = padded[
            radius + dy : radius + dy + h, radius + dx : radius + dx + w, ...
        ]
        if acc is None:
            acc = shifted.copy()
        elif mode == "max":
            np.maximum(acc, shifted, out=acc)
        else:
            np.minimum(acc, shifted, out=acc)
    return acc


@pytest.mark.parametrize(
    "shape", [(37, 53), (64, 64, 3), (5, 200), (200, 5, 3), (1, 1)]
)
@pytest.mark.parametrize("radius", [0, 1, 2, 3, 7, 16, 31])
@pytest.mark.parametrize("mode", ["max", "min"])
def test_matches_reference(shape: tuple[int, ...], radius: int, mode: str) -> None:
    arr = np.random.default_rng(radius).random(shape)
    assert np.array_equal(
        _filter_disc(arr, radius, mode), _reference(arr, radius, mode)
    )
