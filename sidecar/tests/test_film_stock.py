"""`film_stock` — stock-enum film grade with vignette and grain. Same
conventions as `test_technicolor.py`.
"""

from __future__ import annotations

import numpy as np
import pytest
from ops import OPS
from ops.film_stock import (
    _STOCKS,
    _expired_variant,
    _grain_cell,
    _vignette_gain,
    film_stock,
)

STOCKS = list(_STOCKS)
# Colour grade only: grain and vignette off.
GRADE_ONLY = {"grain": 0.0, "vignette": 0.0}
LUMA = np.array([0.2126, 0.7152, 0.0722])


def _random_rgba(rng: np.random.Generator, h: int = 24, w: int = 32) -> np.ndarray:
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)


def _solid(rgb: tuple[int, int, int], h: int = 8, w: int = 8, alpha: int = 255):
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., :3] = rgb
    img[..., 3] = alpha
    return img


def _gradient(h: int = 16, w: int = 64) -> np.ndarray:
    """Greyscale ramp left to right."""
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., :3] = np.linspace(0, 255, w).round().astype(np.uint8)[None, :, None]
    img[..., 3] = 255
    return img


def _colour_gradient(h: int = 16, w: int = 64) -> np.ndarray:
    """Three offset ramps, so colour is present at every tone."""
    t = np.linspace(0, 1, w)
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., 0] = np.round(255 * t)[None, :]
    img[..., 1] = np.round(255 * np.roll(t, w // 3))[None, :]
    img[..., 2] = np.round(255 * (1 - t))[None, :]
    img[..., 3] = 255
    return img


def _sat(img: np.ndarray) -> float:
    """Mean chroma (max - min) of the RGB, 0-1."""
    rgb = img[..., :3].astype(np.float64) / 255.0
    return float((rgb.max(axis=-1) - rgb.min(axis=-1)).mean())


def _luma_std(img: np.ndarray) -> float:
    return float((img[..., :3].astype(np.float64) / 255.0 @ LUMA).std())


def test_registered_with_labelled_params():
    entry = OPS["film_stock"]
    assert entry.backend == "python"
    assert entry.writes_alpha is False
    params = {p["name"]: p for p in entry.to_dict()["params"]}
    assert list(params) == ["stock", "amount", "grain", "vignette", "seed"]
    assert params["stock"]["choices"] == [
        "polaroid_600",
        "sx70",
        "cross_process",
        "bleach_bypass",
        "expired",
    ]
    for name in ("amount", "grain", "vignette"):
        assert params[name]["widget"] == "slider"
        assert (params[name]["min"], params[name]["max"]) == (0.0, 1.0)
    for name in params:
        assert params[name]["scale"] == "none"
        assert params[name]["label"]
        assert params[name]["description"]
    # Each stock's character is described on the enum under the name the
    # picker shows, its choice label.
    labels = params["stock"]["choice_labels"]
    assert set(labels) == set(STOCKS)
    for stock in STOCKS:
        assert f"{labels[stock]}:" in params["stock"]["description"]
    assert "polaroid" not in params["stock"]["description"].lower()
    assert "sx70" not in params["stock"]["description"]


@pytest.mark.parametrize("stock", STOCKS)
def test_amount_zero_with_grain_and_vignette_off_is_identity(stock):
    img = _random_rgba(np.random.default_rng(0))
    out = film_stock(img, {"stock": stock, "amount": 0.0, **GRADE_ONLY, "seed": 3})
    np.testing.assert_array_equal(out, img)


@pytest.mark.parametrize("stock", STOCKS)
def test_amount_governs_the_grade_only(stock):
    """`amount` 0 still applies vignette and grain at their own settings."""
    img = _solid((128, 128, 128), h=32, w=32)
    base = {"stock": stock, "amount": 0.0}
    vig = film_stock(img, {**base, "grain": 0.0, "vignette": 1.0})
    assert vig[0, 0, :3].sum() < img[0, 0, :3].sum()
    # Centre is untouched: the colour grade really is off.
    np.testing.assert_array_equal(vig[16, 16], img[16, 16])
    grainy = film_stock(img, {**base, "grain": 1.0, "vignette": 0.0})
    assert grainy[..., :3].std() > 1.0


@pytest.mark.parametrize("stock", STOCKS)
def test_amount_blends_toward_the_full_grade(stock):
    img = _colour_gradient()
    full = film_stock(img, {"stock": stock, "amount": 1.0, **GRADE_ONLY, "seed": 1})
    half = film_stock(img, {"stock": stock, "amount": 0.5, **GRADE_ONLY, "seed": 1})
    mid = (img[..., :3].astype(int) + full[..., :3].astype(int)) / 2
    assert np.abs(half[..., :3].astype(float) - mid).max() <= 1.0


@pytest.mark.parametrize("stock", STOCKS)
def test_deterministic(stock):
    img = _random_rgba(np.random.default_rng(1))
    params = {"stock": stock, "grain": 0.7, "vignette": 0.6, "seed": 9}
    np.testing.assert_array_equal(film_stock(img, params), film_stock(img, params))


@pytest.mark.parametrize("stock", [s for s in STOCKS if s != "expired"])
def test_seed_is_inert_without_grain_except_for_expired(stock):
    img = _random_rgba(np.random.default_rng(2))
    params = {"stock": stock, **GRADE_ONLY}
    np.testing.assert_array_equal(
        film_stock(img, {**params, "seed": 1}), film_stock(img, {**params, "seed": 2})
    )


def test_seed_changes_expired_even_without_grain():
    img = _colour_gradient()
    params = {"stock": "expired", **GRADE_ONLY}
    outs = [film_stock(img, {**params, "seed": s}) for s in range(6)]
    assert any(not np.array_equal(outs[0], o) for o in outs[1:])


@pytest.mark.parametrize("stock", STOCKS)
def test_seed_changes_grain(stock):
    img = _solid((120, 130, 140), h=24, w=24)
    params = {"stock": stock, "grain": 0.8, "vignette": 0.0}
    assert not np.array_equal(
        film_stock(img, {**params, "seed": 1}), film_stock(img, {**params, "seed": 2})
    )


def test_expired_picks_both_casts_across_seeds_and_each_cast_is_tinted():
    casts = {}
    for seed in range(40):
        variant, name = _expired_variant(_STOCKS["expired"], seed)
        casts[seed] = name
        shadow = np.asarray(variant.shadow_tint)
        # Magenta pulls green down; cyan pulls red down.
        assert int(np.argmin(shadow)) == (1 if name == "magenta" else 0)
        assert shadow.min() < -0.03
    assert set(casts.values()) == {"magenta", "cyan"}


def test_expired_cast_does_not_depend_on_grain():
    img = _solid((128, 128, 128), h=16, w=16)
    a = film_stock(img, {"stock": "expired", "grain": 0.0, "vignette": 0.0, "seed": 4})
    b = film_stock(img, {"stock": "expired", "grain": 0.4, "vignette": 0.0, "seed": 4})
    assert (
        np.abs(
            a[..., :3].astype(float).mean(axis=(0, 1))
            - b[..., :3].astype(float).mean(axis=(0, 1))
        ).max()
        < 3.0
    )


def test_every_stock_is_distinct_on_a_gradient():
    img = _gradient()
    outs = {s: film_stock(img, {"stock": s, **GRADE_ONLY, "seed": 0}) for s in STOCKS}
    for i, a in enumerate(STOCKS):
        for b in STOCKS[i + 1 :]:
            diff = np.abs(outs[a][..., :3].astype(int) - outs[b][..., :3].astype(int))
            assert diff.mean() > 3.0, (a, b)


def test_bleach_bypass_is_less_saturated_than_the_input():
    img = _colour_gradient()
    out = film_stock(img, {"stock": "bleach_bypass", **GRADE_ONLY})
    assert _sat(out) < _sat(img) * 0.7
    # And it is the least saturated of the stocks on the same input.
    others = [
        _sat(film_stock(img, {"stock": s, **GRADE_ONLY}))
        for s in STOCKS
        if s != "bleach_bypass"
    ]
    assert _sat(out) < min(others)


def test_cross_process_raises_contrast():
    img = _colour_gradient()
    out = film_stock(img, {"stock": "cross_process", **GRADE_ONLY})
    assert _luma_std(out) > _luma_std(img) * 1.1
    # The two instant stocks do the opposite.
    for soft in ("polaroid_600", "sx70"):
        assert _luma_std(film_stock(img, {"stock": soft, **GRADE_ONLY})) < _luma_std(
            img
        )


def test_cross_process_colours_shadows_blue_and_highlights_yellow_green():
    dark = film_stock(_solid((40, 40, 40)), {"stock": "cross_process", **GRADE_ONLY})[
        0, 0
    ]
    light = film_stock(
        _solid((220, 220, 220)), {"stock": "cross_process", **GRADE_ONLY}
    )[0, 0]
    assert dark[2] > dark[0]
    assert light[1] > light[2] and light[0] > light[2]


@pytest.mark.parametrize("stock", ["polaroid_600", "sx70", "expired"])
def test_faded_stocks_lift_pure_black(stock):
    out = film_stock(_solid((0, 0, 0)), {"stock": stock, **GRADE_ONLY, "seed": 1})
    assert out[0, 0, :3].mean() > 12


def test_instant_blacks_are_lifted_and_whites_dimmed():
    out = film_stock(_solid((0, 0, 0)), {"stock": "polaroid_600", **GRADE_ONLY})
    assert (out[0, 0, :3] > 0).all()
    white = film_stock(_solid((255, 255, 255)), {"stock": "polaroid_600", **GRADE_ONLY})
    assert (white[0, 0, :3] < 255).all()
    assert white[0, 0, 0] > white[0, 0, 2]  # warm, creamy


def test_instant_faded_is_warmer_than_instant():
    img = _solid((128, 128, 128))
    pol = film_stock(img, {"stock": "polaroid_600", **GRADE_ONLY})[0, 0].astype(int)
    sx = film_stock(img, {"stock": "sx70", **GRADE_ONLY})[0, 0].astype(int)
    assert (sx[0] - sx[2]) > (pol[0] - pol[2])


@pytest.mark.parametrize("stock", STOCKS)
def test_vignette_darkens_corners_more_than_centre(stock):
    img = _solid((150, 150, 150), h=40, w=60)
    out = film_stock(
        img, {"stock": stock, "amount": 0.0, "grain": 0.0, "vignette": 1.0}
    )
    corner = out[0, 0, :3].astype(int).sum()
    edge = out[0, 30, :3].astype(int).sum()
    centre = out[20, 30, :3].astype(int).sum()
    assert corner < edge < centre + 1
    assert corner < centre - 20


@pytest.mark.parametrize("stock", STOCKS)
def test_vignette_zero_is_a_no_op(stock):
    img = _random_rgba(np.random.default_rng(3))
    graded = film_stock(img, {"stock": stock, "grain": 0.0, "vignette": 0.0})
    # With the vignette on at amount 0 the centre-most pixels move, with it
    # off nothing outside the grade does.
    off = film_stock(
        img, {"stock": stock, "amount": 0.0, "grain": 0.0, "vignette": 0.0}
    )
    np.testing.assert_array_equal(off, img)
    assert graded.shape == img.shape


def test_vignette_is_resolution_independent():
    small = _vignette_gain(32, 48, 0.5, 0.3)[..., 0]
    large = _vignette_gain(128, 192, 0.5, 0.3)[..., 0]
    # Same fractional positions land on the same gain.
    np.testing.assert_allclose(small[0, 0], large[0, 0], atol=0.01)
    np.testing.assert_allclose(small[16, 24], large[64, 96], atol=0.01)
    np.testing.assert_allclose(small[8, 12], large[32, 48], atol=0.02)
    # Corner reaches the full depth.
    assert small[0, 0] < 0.6


def test_grain_speck_is_a_fixed_fraction_of_the_frame():
    # The long edge always holds the same number of specks once it is wide
    # enough, so the speck scales with the buffer.
    assert _grain_cell(100, 200) == 1.0  # clamped to a pixel
    big = _grain_cell(1920, 2560)
    assert _grain_cell(960, 1280) == pytest.approx(big / 2)
    assert _grain_cell(3840, 5120) == pytest.approx(big * 2)


def test_grain_strength_matches_across_resolutions():
    for stock in ("polaroid_600", "bleach_bypass"):
        stds = []
        for size in (96, 192):
            img = _solid((128, 128, 128), h=size, w=size)
            out = film_stock(
                img, {"stock": stock, "amount": 0.0, "grain": 1.0, "vignette": 0.0}
            )
            stds.append(out[..., :3].astype(float).std())
        assert stds[0] > 3.0
        assert stds[1] == pytest.approx(stds[0], rel=0.15)


def test_grain_is_stronger_when_turned_up_and_absent_at_zero():
    img = _solid((128, 128, 128), h=32, w=32)
    base = {"stock": "sx70", "amount": 0.0, "vignette": 0.0, "seed": 5}
    low = film_stock(img, {**base, "grain": 0.2})[..., :3].astype(float).std()
    high = film_stock(img, {**base, "grain": 1.0})[..., :3].astype(float).std()
    assert 0 < low < high
    np.testing.assert_array_equal(film_stock(img, {**base, "grain": 0.0}), img)


def test_bleach_bypass_grain_is_mono():
    img = _solid((128, 128, 128), h=24, w=24)
    out = film_stock(
        img, {"stock": "bleach_bypass", "amount": 0.0, "grain": 1.0, "vignette": 0.0}
    )
    np.testing.assert_array_equal(out[..., 0], out[..., 1])
    np.testing.assert_array_equal(out[..., 1], out[..., 2])


@pytest.mark.parametrize("stock", STOCKS)
def test_alpha_untouched(stock):
    img = _random_rgba(np.random.default_rng(6))
    out = film_stock(img, {"stock": stock, "grain": 1.0, "vignette": 1.0, "seed": 2})
    np.testing.assert_array_equal(out[..., 3], img[..., 3])


@pytest.mark.parametrize("stock", STOCKS)
def test_shape_dtype_and_input_not_mutated(stock):
    img = _random_rgba(np.random.default_rng(7))
    before = img.copy()
    out = film_stock(img, {"stock": stock, "grain": 0.8, "vignette": 0.8, "seed": 5})
    assert out.shape == img.shape
    assert out.dtype == np.uint8
    assert out is not img
    np.testing.assert_array_equal(img, before)


def test_nothing_active_returns_a_copy():
    img = _random_rgba(np.random.default_rng(8))
    out = film_stock(img, {"amount": 0.0, **GRADE_ONLY})
    out[0, 0, 0] ^= 0xFF
    assert out[0, 0, 0] != img[0, 0, 0]


def test_unknown_stock_falls_back_to_the_default():
    img = _random_rgba(np.random.default_rng(9))
    np.testing.assert_array_equal(
        film_stock(img, {"stock": "nope", **GRADE_ONLY}),
        film_stock(img, {"stock": "polaroid_600", **GRADE_ONLY}),
    )
