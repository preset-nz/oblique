"""Levels with output black and white (`features/27-driven-params/levels-curve.md`).

At the defaults the op is the one it was before output black and white existed, byte for
byte; away from them the LUT is `out_black + (out_white - out_black) * power`."""

from __future__ import annotations

import itertools
from typing import Any

import numpy as np
import pytest
from ops import OPS
from ops.levels import levels


def _img() -> np.ndarray:
    rng = np.random.default_rng(3)
    img = rng.integers(0, 256, (24, 40, 4), dtype=np.uint8)
    # every value 0..255 appears in every colour channel
    img[0, :, :3] = np.arange(256)[:40, None]
    img.reshape(-1, 4)[:256, :3] = np.arange(256, dtype=np.uint8)[:, None]
    return img


def _before(img: np.ndarray, black: float, white: float, gamma: float) -> np.ndarray:
    """The op as it was before output black and white: the reference for the defaults."""
    if white <= black:
        white = black + 1.0
    domain = np.arange(256, dtype=np.float64)
    normalised = np.clip((domain - black) / (white - black), 0.0, 1.0)
    lut = np.clip(np.power(normalised, 1.0 / gamma) * 255.0, 0.0, 255.0)
    lut = lut.astype(np.uint8)
    out = img.copy()
    out[..., :3] = lut[out[..., :3]]
    return out


GAMMAS = [0.1, 0.45, 0.8, 1.0, 1.0001, 1.6, 2.2, 3.7, 5.0]
BLACKS = [0.0, 1.0, 20.0, 100.0, 254.0, 255.0]
WHITES = [0.0, 1.0, 100.0, 230.0, 254.0, 255.0]


@pytest.mark.parametrize(
    ("black", "white", "gamma"), list(itertools.product(BLACKS, WHITES, GAMMAS))
)
def test_at_the_default_outputs_the_op_is_what_it_was(
    black: float, white: float, gamma: float
) -> None:
    img = _img()
    now = levels(img, {"black": black, "white": white, "gamma": gamma})
    assert np.array_equal(now, _before(img, black, white, gamma))
    explicit = levels(
        img,
        {
            "black": black,
            "white": white,
            "gamma": gamma,
            "out_black": 0.0,
            "out_white": 255.0,
        },
    )
    assert np.array_equal(explicit, now)


def _lut(params: dict[str, Any]) -> np.ndarray:
    ramp = np.zeros((1, 256, 4), dtype=np.uint8)
    ramp[..., 3] = 255
    ramp[0, :, :3] = np.arange(256, dtype=np.uint8)[:, None]
    return levels(ramp, params)[0, :, 0]


def test_output_black_lifts_the_shadows_and_output_white_dulls_the_highlights() -> None:
    lut = _lut({"out_black": 40.0, "out_white": 200.0})
    assert lut[0] == 40
    assert lut[255] == 200
    assert lut.min() == 40 and lut.max() == 200
    assert (np.diff(lut.astype(int)) >= 0).all()


@pytest.mark.parametrize(
    ("black", "white", "gamma", "ob", "ow"),
    [
        (0, 255, 1.0, 40, 255),
        (0, 255, 2.0, 0, 180),
        (20, 230, 1.6, 40, 200),
        (60, 120, 0.5, 100, 140),
        (0, 255, 5.0, 254, 255),
    ],
)
def test_the_lut_is_out_black_plus_the_span_times_the_power(
    black: float, white: float, gamma: float, ob: float, ow: float
) -> None:
    lut = _lut(
        {
            "black": black,
            "white": white,
            "gamma": gamma,
            "out_black": ob,
            "out_white": ow,
        }
    )
    x = np.clip((np.arange(256) - black) / (white - black), 0.0, 1.0)
    want = (ob + (ow - ob) * x ** (1.0 / gamma)).astype(np.uint8)
    assert np.array_equal(lut, want)


@pytest.mark.parametrize("out_black", [100.0, 255.0])
def test_output_white_at_or_below_output_black_is_held_one_above_it(
    out_black: float,
) -> None:
    lut = _lut({"out_black": out_black, "out_white": 0.0})
    guard = _lut({"out_black": out_black, "out_white": out_black + 1.0})
    assert np.array_equal(lut, guard)


def test_alpha_is_untouched_and_the_input_is_not_mutated() -> None:
    img = _img()
    before = img.copy()
    out = levels(img, {"out_black": 30.0, "out_white": 90.0})
    assert np.array_equal(out[..., 3], img[..., 3])
    assert np.array_equal(img, before)


def test_the_new_params_are_declared_with_their_ranges() -> None:
    params = {p["name"]: p for p in OPS["levels"].to_dict()["params"]}
    assert [n for n in params] == ["black", "white", "gamma", "out_black", "out_white"]
    for name, default, label in (
        ("out_black", 0.0, "Output black"),
        ("out_white", 255.0, "Output white"),
    ):
        p = params[name]
        assert (p["min"], p["max"], p["default"], p["step"]) == (
            0.0,
            255.0,
            default,
            1.0,
        )
        assert p["label"] == label and p["description"]
