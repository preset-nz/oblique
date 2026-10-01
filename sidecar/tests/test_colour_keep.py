"""`colour_keep` — keep chosen hues, send the rest to Rec. 709 grey. Same
conventions as `test_flavour_ops.py`.
"""

from __future__ import annotations

import colorsys

import numpy as np
import pytest

from ops import LUMA_B709, LUMA_G709, LUMA_R709, OPS
from ops.colour_keep import colour_keep
from ops.desaturate import desaturate

RED = (255, 0, 0)
GREEN = (0, 255, 0)
BLUE = (0, 0, 255)


def _row(*pixels: tuple[int, int, int], alpha: int = 255) -> np.ndarray:
    img = np.zeros((1, len(pixels), 4), dtype=np.uint8)
    for i, rgb in enumerate(pixels):
        img[0, i, :3] = rgb
        img[0, i, 3] = alpha
    return img


def _hue_pixel(degrees: float, s: float = 1.0, v: float = 1.0) -> tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb(degrees / 360.0, s, v)
    return (round(r * 255), round(g * 255), round(b * 255))


def _luma(rgb: tuple[int, int, int]) -> int:
    return int(rgb[0] * LUMA_R709 + rgb[1] * LUMA_G709 + rgb[2] * LUMA_B709)


def _random_rgba(rng: np.random.Generator, h: int = 24, w: int = 32) -> np.ndarray:
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)


BASE = {"keep": "#ff0000", "hue_range": 20.0, "softness": 0.0, "amount": 1.0}


def test_registered_with_second_band_disabled_until_switched_on():
    entry = OPS["colour_keep"]
    assert entry.backend == "python"
    assert entry.writes_alpha is False
    params = {p["name"]: p for p in entry.to_dict()["params"]}
    assert params["use_keep_2"]["default"] is False
    for name in ("keep_2", "hue_range_2"):
        assert params[name]["disabledWhen"] == {"path": "use_keep_2", "equals": False}
    assert "disabledWhen" not in params["keep"]


def test_keep_band_pixel_is_exactly_unchanged_at_amount_one():
    img = _row(RED, _hue_pixel(10), _hue_pixel(350, s=0.8, v=0.7))
    out = colour_keep(img, {**BASE, "hue_range": 25.0})
    np.testing.assert_array_equal(out, img)


def test_out_of_band_pixel_goes_to_rec709_grey():
    img = _row(GREEN, BLUE, _hue_pixel(180))
    out = colour_keep(img, BASE)
    for i, rgb in enumerate([GREEN, BLUE, _hue_pixel(180)]):
        grey = _luma(rgb)
        assert tuple(out[0, i, :3]) == (grey, grey, grey)
    # And it is exactly what `desaturate` produces at amount 1.
    np.testing.assert_array_equal(out, desaturate(img, {"amount": 1.0}))


def test_hue_distance_wraps_around_360():
    keep_red_at_355 = {**BASE, "keep": "#ff0000", "hue_range": 12.0}
    # Hue 355 swatch, pixel at 5: distance 10 across the wrap.
    swatch = "#{:02x}{:02x}{:02x}".format(*_hue_pixel(355))
    near = _row(_hue_pixel(5))
    far = _row(_hue_pixel(30))
    p = {**keep_red_at_355, "keep": swatch}
    np.testing.assert_array_equal(colour_keep(near, p), near)
    assert colour_keep(far, p)[0, 0, 0] == colour_keep(far, p)[0, 0, 1]
    # And the other direction: keep 5, pixel at 355.
    swatch5 = "#{:02x}{:02x}{:02x}".format(*_hue_pixel(5))
    pix = _row(_hue_pixel(355))
    np.testing.assert_array_equal(colour_keep(pix, {**p, "keep": swatch5}), pix)


def test_softness_gives_a_monotonic_falloff():
    hues = [20 + 2 * i for i in range(0, 21)]  # 20..60, band edge at 20
    img = _row(*[_hue_pixel(h) for h in hues])
    out = colour_keep(img, {**BASE, "softness": 40.0, "hue_range": 20.0})

    def chroma(px: np.ndarray) -> int:
        return int(px[:3].max()) - int(px[:3].min())

    chromas = [chroma(out[0, i]) for i in range(len(hues))]
    assert chromas[0] == chroma(img[0, 0])  # at the edge: untouched
    assert chromas[-1] == 0  # a full softness past the edge: grey
    # Colour is only ever lost as the hue moves away from the band.
    for a, b in zip(chromas, chromas[1:]):
        assert b <= a + 1
    assert chromas[len(chromas) // 2] > 0  # genuinely partial in the middle
    assert chromas[len(chromas) // 2] < chromas[0]


def test_hard_edge_when_softness_is_zero():
    img = _row(_hue_pixel(19), _hue_pixel(21))
    out = colour_keep(img, {**BASE, "hue_range": 20.0})
    np.testing.assert_array_equal(out[0, 0], img[0, 0])
    assert out[0, 1, 0] == out[0, 1, 1] == out[0, 1, 2]


def test_min_saturation_stops_near_grey_pixels_counting_as_kept():
    reddish_shadow = (40, 36, 36)  # hue 0, but barely any colour
    vivid = RED
    img = _row(reddish_shadow, vivid)

    permissive = colour_keep(img, {**BASE, "min_saturation": 0.0})
    np.testing.assert_array_equal(permissive[0, 0], img[0, 0])  # kept as-is

    gated = colour_keep(img, {**BASE, "min_saturation": 0.2})
    grey = _luma(reddish_shadow)
    assert tuple(gated[0, 0, :3]) == (grey, grey, grey)
    np.testing.assert_array_equal(gated[0, 1], img[0, 1])  # vivid still kept


def test_pure_grey_is_never_kept_even_with_the_gate_off():
    # Greys are already grey: nothing visibly changes either way.
    img = _row((128, 128, 128))
    out = colour_keep(img, {**BASE, "min_saturation": 1.0})
    assert out[0, 0, 0] == out[0, 0, 1] == out[0, 0, 2]


def test_amount_zero_is_identity():
    img = _random_rgba(np.random.default_rng(3))
    out = colour_keep(img, {**BASE, "amount": 0.0})
    np.testing.assert_array_equal(out, img)
    assert out is not img


def test_partial_amount_blends_out_of_band_pixels_only():
    img = _row(RED, BLUE)
    out = colour_keep(img, {**BASE, "amount": 0.5})
    np.testing.assert_array_equal(out[0, 0], img[0, 0])
    expected = colour_keep(img, {**BASE, "amount": 1.0})
    # Halfway between the original and the full grey, give or take rounding.
    mid = (img[0, 1, :3].astype(int) + expected[0, 1, :3].astype(int)) / 2
    assert np.all(np.abs(out[0, 1, :3].astype(int) - mid) <= 1)


def test_deterministic_and_does_not_mutate_input():
    img = _random_rgba(np.random.default_rng(4))
    before = img.copy()
    params = {**BASE, "softness": 30.0, "min_saturation": 0.15, "use_keep_2": True}
    a = colour_keep(img, params)
    b = colour_keep(img, params)
    np.testing.assert_array_equal(a, b)
    np.testing.assert_array_equal(img, before)
    assert a.shape == img.shape and a.dtype == np.uint8


@pytest.mark.parametrize("alpha", [0, 1, 128, 255])
def test_alpha_untouched(alpha):
    rng = np.random.default_rng(5)
    img = _random_rgba(rng)
    img[..., 3] = alpha
    out = colour_keep(img, {**BASE, "softness": 25.0})
    np.testing.assert_array_equal(out[..., 3], img[..., 3])

    img = _random_rgba(rng)
    out = colour_keep(img, {**BASE, "use_keep_2": True})
    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_second_band_keeps_a_second_hue_only_when_switched_on():
    img = _row(RED, BLUE, GREEN)
    p = {**BASE, "keep_2": "#0000ff", "hue_range_2": 20.0}

    off = colour_keep(img, {**p, "use_keep_2": False})
    np.testing.assert_array_equal(off[0, 0], img[0, 0])
    assert off[0, 1, 0] == off[0, 1, 1] == off[0, 1, 2]  # blue greyed

    on = colour_keep(img, {**p, "use_keep_2": True})
    np.testing.assert_array_equal(on[0, 0], img[0, 0])  # red kept
    np.testing.assert_array_equal(on[0, 1], img[0, 1])  # blue kept
    grey = _luma(GREEN)
    assert tuple(on[0, 2, :3]) == (grey, grey, grey)  # green still goes


def test_second_band_uses_its_own_hue_range():
    near_blue = _row(_hue_pixel(240 + 30))
    p = {**BASE, "use_keep_2": True, "keep_2": "#0000ff"}
    narrow = colour_keep(near_blue, {**p, "hue_range_2": 10.0})
    wide = colour_keep(near_blue, {**p, "hue_range_2": 40.0})
    assert narrow[0, 0, 0] == narrow[0, 0, 1] == narrow[0, 0, 2]
    np.testing.assert_array_equal(wide, near_blue)


def test_garbage_colour_falls_back_to_default_and_does_not_raise():
    img = _random_rgba(np.random.default_rng(6))
    default = colour_keep(img, {**BASE, "keep": "#d02020"})
    garbage = colour_keep(img, {**BASE, "keep": "puce"})
    np.testing.assert_array_equal(default, garbage)
