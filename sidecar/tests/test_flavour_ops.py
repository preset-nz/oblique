"""Unit tests for the 2026-07-04 flavour-ops batch: `colour_crush`,
`xerox`, `ink_starved`. Same conventions as `test_ops.py` — shape/dtype
preservation, alpha passthrough, seed determinism, edge-of-range params.
"""

from __future__ import annotations

import numpy as np
import pytest

from ops import OPS
from ops.colour_crush import colour_crush
from ops.ink_starved import ink_starved
from ops.xerox import xerox

ALL_OPS = [
    (colour_crush, {"bits": 3, "dither": False}),
    (xerox, {"generations": 3, "streaks": 0.2, "skew": 0.3, "seed": 7}),
    (ink_starved, {"direction": "h", "starvation": 0.4, "banding": 0.2, "seed": 7}),
]


def _random_rgba(rng: np.random.Generator, h: int = 24, w: int = 32) -> np.ndarray:
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)


@pytest.mark.parametrize("fn,params", ALL_OPS)
def test_shape_and_dtype_preserved(fn, params):
    rng = np.random.default_rng(0)
    img = _random_rgba(rng)

    out = fn(img, params)

    assert out.shape == img.shape
    assert out.dtype == np.uint8


@pytest.mark.parametrize("fn,params", ALL_OPS)
def test_op_does_not_mutate_input(fn, params):
    rng = np.random.default_rng(1)
    img = _random_rgba(rng)
    before = img.copy()

    fn(img, params)

    np.testing.assert_array_equal(img, before)


@pytest.mark.parametrize("fn,params", ALL_OPS)
def test_alpha_untouched(fn, params):
    rng = np.random.default_rng(2)
    img = _random_rgba(rng)

    out = fn(img, params)

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


@pytest.mark.parametrize(
    "name",
    ["colour_crush", "xerox", "ink_starved"],
)
def test_registered_in_ops_registry(name):
    assert name in OPS
    assert OPS[name].backend == "python"
    for param in OPS[name].to_dict()["params"]:
        assert "scale" in param
        assert param["scale"] in ("spatial", "none")


# --- colour_crush -----------------------------------------------------


def test_colour_crush_reduces_unique_values_per_channel():
    rng = np.random.default_rng(3)
    img = _random_rgba(rng, h=32, w=32)

    out = colour_crush(img, {"bits": 2, "dither": False})

    for c in range(3):
        assert len(np.unique(out[..., c])) <= 2**2


def test_colour_crush_bits_8_is_identity_on_rgb():
    rng = np.random.default_rng(4)
    img = _random_rgba(rng)

    out = colour_crush(img, {"bits": 8, "dither": False})

    np.testing.assert_array_equal(out[..., :3], img[..., :3])


def test_colour_crush_per_channel_override():
    rng = np.random.default_rng(5)
    img = _random_rgba(rng, h=32, w=32)

    out = colour_crush(
        img, {"bits": 8, "dither": False, "bits_r": 1, "bits_g": 0, "bits_b": 0}
    )

    assert len(np.unique(out[..., 0])) <= 2
    np.testing.assert_array_equal(out[..., 1:3], img[..., 1:3])


def test_colour_crush_dither_does_not_throw_and_stays_in_range():
    rng = np.random.default_rng(6)
    img = _random_rgba(rng, h=20, w=20)

    out = colour_crush(img, {"bits": 3, "dither": True})

    assert out.dtype == np.uint8
    assert out.min() >= 0
    assert out.max() <= 255


def test_colour_crush_edge_params_do_not_throw():
    rng = np.random.default_rng(7)
    img = _random_rgba(rng)

    lo = colour_crush(img, {"bits": 1, "dither": True})
    hi = colour_crush(img, {"bits": 8, "dither": True})

    assert lo.shape == img.shape
    assert hi.shape == img.shape


# --- xerox --------------------------------------------------------------


def test_xerox_seed_determinism():
    rng = np.random.default_rng(8)
    img = _random_rgba(rng, h=40, w=40)
    params = {
        "generations": 4,
        "streaks": 0.5,
        "skew": 1.0,
        "toner_noise": 0.4,
        "edge_bloom": 0.3,
        "seed": 42,
    }

    first = xerox(img, params)
    second = xerox(img, params)

    np.testing.assert_array_equal(first, second)


def test_xerox_different_seed_differs():
    rng = np.random.default_rng(9)
    img = _random_rgba(rng, h=40, w=40)

    a = xerox(img, {"generations": 3, "streaks": 0.5, "seed": 1})
    b = xerox(img, {"generations": 3, "streaks": 0.5, "seed": 2})

    assert not np.array_equal(a, b)


def test_xerox_mono_by_default():
    rng = np.random.default_rng(10)
    img = _random_rgba(rng, h=20, w=20)

    out = xerox(img, {"generations": 2, "streaks": 0.0, "skew": 0.0, "seed": 3})

    assert np.all(out[..., 0] == out[..., 1])
    assert np.all(out[..., 1] == out[..., 2])


def test_xerox_keep_colour_preserves_channel_variety():
    img = np.zeros((16, 16, 4), dtype=np.uint8)
    img[..., 0] = 200
    img[..., 1] = 40
    img[..., 2] = 40
    img[..., 3] = 255

    out = xerox(
        img,
        {
            "generations": 1,
            "streaks": 0.0,
            "skew": 0.0,
            "toner_noise": 0.0,
            "edge_bloom": 0.0,
            "keep_colour": True,
            "seed": 5,
        },
    )

    assert out[..., 0].mean() > out[..., 1].mean()


def test_xerox_edge_params_at_extremes_do_not_throw():
    rng = np.random.default_rng(11)
    img = _random_rgba(rng, h=24, w=24)

    out = xerox(
        img,
        {
            "generations": 10,
            "streaks": 1.0,
            "skew": 2.0,
            "toner_noise": 1.0,
            "edge_bloom": 1.0,
            "keep_colour": True,
            "seed": 6,
        },
    )

    assert out.shape == img.shape
    assert out.dtype == np.uint8


# --- ink_starved ----------------------------------------------------------


def test_ink_starved_fades_along_direction():
    img = np.full((16, 40, 4), 40, dtype=np.uint8)  # dark ink field
    img[..., 3] = 255

    out = ink_starved(
        img, {"direction": "h", "starvation": 1.0, "banding": 0.0, "seed": 1}
    )

    start_lum = out[:, :4, :3].mean()
    end_lum = out[:, -4:, :3].mean()
    assert end_lum > start_lum, "far end of the run should be more starved (paler)"


def test_ink_starved_vertical_direction():
    img = np.full((40, 16, 4), 40, dtype=np.uint8)
    img[..., 3] = 255

    out = ink_starved(
        img, {"direction": "v", "starvation": 1.0, "banding": 0.0, "seed": 1}
    )

    start_lum = out[:4, :, :3].mean()
    end_lum = out[-4:, :, :3].mean()
    assert end_lum > start_lum


def test_ink_starved_zero_starvation_zero_banding_is_near_identity():
    rng = np.random.default_rng(12)
    img = _random_rgba(rng, h=20, w=20)
    img[..., :3] = 30  # solid dark ink, no per-pixel variance to confuse the check

    out = ink_starved(
        img, {"direction": "h", "starvation": 0.0, "banding": 0.0, "seed": 2}
    )

    np.testing.assert_allclose(out[..., :3], img[..., :3], atol=1)


def test_ink_starved_single_channel_isolates_plate():
    img = np.zeros((20, 20, 4), dtype=np.uint8)
    img[..., 0] = 255  # pure red -> only magenta/yellow plates are non-zero
    img[..., 3] = 255

    out_all = ink_starved(
        img, {"direction": "h", "starvation": 1.0, "banding": 0.0, "channel": "c"}
    )
    # Starving the (already near-empty) cyan plate on pure red should barely
    # change anything.
    np.testing.assert_allclose(
        out_all[..., :3].astype(int), img[..., :3].astype(int), atol=2
    )


def test_ink_starved_single_channel_visibly_fades_when_present():
    # Pure cyan-bearing pixel (red channel low, green/blue high) -> the
    # cyan plate is fully loaded. Starving it should visibly lighten red.
    img = np.zeros((16, 16, 4), dtype=np.uint8)
    img[..., 0] = 0
    img[..., 1] = 255
    img[..., 2] = 255
    img[..., 3] = 255

    full = ink_starved(
        img, {"direction": "h", "starvation": 0.0, "banding": 0.0, "channel": "c"}
    )
    starved = ink_starved(
        img, {"direction": "h", "starvation": 1.0, "banding": 0.0, "channel": "c"}
    )

    # Far end of the run (fully starved) should show red bleeding back in
    # relative to the near end (still full cyan ink).
    assert starved[:, -1, 0].mean() > full[:, -1, 0].mean()


def test_ink_starved_seed_determinism_with_banding():
    rng = np.random.default_rng(13)
    img = _random_rgba(rng, h=24, w=24)
    params = {"direction": "h", "starvation": 0.5, "banding": 0.6, "seed": 99}

    first = ink_starved(img, params)
    second = ink_starved(img, params)

    np.testing.assert_array_equal(first, second)


def test_ink_starved_edge_params_do_not_throw():
    rng = np.random.default_rng(14)
    img = _random_rgba(rng)

    out = ink_starved(
        img,
        {"direction": "v", "starvation": 1.0, "banding": 1.0, "channel": "k"},
    )

    assert out.shape == img.shape
    assert out.dtype == np.uint8
