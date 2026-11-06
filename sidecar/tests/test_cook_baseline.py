"""Undriven ops cook byte-identically to before Epic 27 story 1.

These are sha256 digests of `handle_cook` output taken from the code before
the driver work (2026-10-31, `features/27-driven-params/blur-radius.md`,
"Baseline"). They hold the story's rule: an op with no driver is called, and
its output encoded, exactly as it was. Never re-pin one to make a change pass.
"""

from __future__ import annotations

import hashlib

import numpy as np
import pytest
from handlers.cook import handle_cook

W, H = 64, 48


def _img() -> bytes:
    rng = np.random.default_rng(27)
    return rng.integers(0, 256, (H, W, 4), dtype=np.uint8).tobytes()


def _mask() -> bytes:
    return (np.arange(W * H) * 7 % 256).astype(np.uint8).tobytes()


def _digest(modifiers: list[dict], masks: bool = False) -> str:
    header: dict = {"id": "baseline", "width": W, "height": H, "modifiers": modifiers}
    payload = _img()
    if masks:
        header["masks"] = [{"modifierIndex": 0, "mask_bytes": W * H}]
        payload += _mask()
    response, out = handle_cook(header, payload)
    assert response["ok"] is True, response
    return hashlib.sha256(out).hexdigest()


BASELINE = [
    (
        "gaussian_blur",
        [{"type": "gaussian_blur", "params": {"radius": 3.5}}],
        False,
        "57ff1418f0c7ad04425e281e2bdde43e3505134c3c469fbf0fa7f2ba9f15ebe1",
    ),
    (
        "levels",
        [
            {
                "type": "levels",
                "params": {"black": 12, "white": 230, "gamma": 1.3},
            }
        ],
        False,
        "d9001fd83172929335f357979094f97312ec792d5cc446e5ddc2711a8f3e3db7",
    ),
    (
        "grain",
        [{"type": "grain", "params": {"amount": 0.3, "size": 2, "seed": 9}}],
        False,
        "eb0ddb8cd922bbfe6c0cef4c2f1d59fc7db8c4e0823d06edb22e679772fa1bc3",
    ),
    (
        "cmyk_halftone",
        [{"type": "cmyk_halftone", "params": {}}],
        False,
        "920a52953190d3f660718c3e027c815f254b3529cb3e408b6c1326dac91c9b2d",
    ),
    (
        "stack",
        [
            {"type": "gaussian_blur", "params": {"radius": 1.5}},
            {"type": "threshold", "params": {"level": 120, "smooth": 20}},
            {"type": "invert", "params": {}},
        ],
        False,
        "744e8efb49f9eab2e66ca4c8a480e1cee3254b91c6d3adf97dde23f5208b7883",
    ),
    (
        "blur_with_mask",
        [{"type": "gaussian_blur", "params": {"radius": 3.5}}],
        True,
        "c16e8aa235e7a1aa091f64b9703368441b3dd1c4aa478dcd6be21be0f68711fa",
    ),
]


@pytest.mark.parametrize(
    ("modifiers", "masks", "expected"),
    [b[1:] for b in BASELINE],
    ids=[b[0] for b in BASELINE],
)
def test_undriven_cook_is_byte_identical_to_before_drivers(modifiers, masks, expected):
    assert _digest(modifiers, masks) == expected
