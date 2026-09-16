"""Semantic tests for `hatch` (epic 18, story 1: tone model, `lines` and
`dashes`). `PATTERNS` is deliberately a module-level tuple so story 2
(`crosses`, `stipple`) extends coverage by appending to it rather than
duplicating every test.
"""

from __future__ import annotations

import numpy as np
import pytest

from ops import OPS
from ops.hatch import _area, _hash01, hatch

PATTERNS = ("lines", "dashes")


def _flat(value: int, h: int = 40, w: int = 40) -> np.ndarray:
    return np.full((h, w, 4), value, dtype=np.uint8)


def _random_rgba(rng: np.random.Generator, h: int = 24, w: int = 32) -> np.ndarray:
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)


# --- shared battery ---------------------------------------------------------


def test_shape_and_dtype_preserved():
    rng = np.random.default_rng(0)
    img = _random_rgba(rng)

    out = hatch(img, {"pattern": "dashes", "layers": 3, "seed": 7})

    assert out.shape == img.shape
    assert out.dtype == np.uint8


def test_does_not_mutate_input():
    rng = np.random.default_rng(1)
    img = _random_rgba(rng)
    before = img.copy()

    hatch(img, {"pattern": "dashes", "layers": 3, "seed": 7})

    np.testing.assert_array_equal(img, before)


def test_registered_in_ops_registry():
    assert "hatch" in OPS
    assert OPS["hatch"].backend == "python"
    assert OPS["hatch"].writes_alpha is True
    for param in OPS["hatch"].to_dict()["params"]:
        assert "scale" in param
        assert param["scale"] in ("spatial", "none")


# --- white closes to paper ---------------------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
@pytest.mark.parametrize("layers", [1, 2, 3, 4])
def test_white_closes_to_paper(pattern, layers):
    img = _flat(255)

    out = hatch(img, {"pattern": pattern, "layers": layers, "paper": "#f0e6d2"})

    expected = np.array([0xF0, 0xE6, 0xD2], dtype=np.uint8)
    assert np.all(out[..., :3] == expected)


# --- black closes to ink: no pinholes ---------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
@pytest.mark.parametrize("layers", [1, 2, 3, 4])
@pytest.mark.parametrize("angle", [0, 30, 45])
@pytest.mark.parametrize("spacing", [4, 7.5])
def test_black_closes_to_ink_no_pinholes(pattern, layers, angle, spacing):
    img = _flat(0)

    out = hatch(
        img,
        {
            "pattern": pattern,
            "layers": layers,
            "weight": 1.0,
            "angle": angle,
            "spacing": spacing,
            "seed": 7,
        },
    )

    assert np.all(out[..., :3] == 0)


@pytest.mark.parametrize("pattern", PATTERNS)
def test_black_closes_to_ink_no_pinholes_at_document_scale(pattern):
    # float32 accumulates rounding error in `v = -x*sin + y*cos` as the
    # coordinate magnitude grows with image size; `angle=45` maximises
    # `|v|` for a given diagonal. 1024x1024 is a realistic document size,
    # well past the 40x40 tiles the other pinhole cases use, and pins that
    # the box-filter overdrive still closes exactly at that scale.
    img = _flat(0, h=1024, w=1024)

    out = hatch(
        img,
        {"pattern": pattern, "layers": 4, "weight": 1.0, "angle": 45, "seed": 7},
    )

    assert np.all(out[..., :3] == 0)


# --- weight < 1 stays open ----------------------------------------------------


def test_weight_below_one_stays_open():
    img = _flat(0)

    out = hatch(img, {"weight": 0.5})

    assert np.any(np.all(out[..., :3] == 255, axis=-1))


# --- monotonic ----------------------------------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
@pytest.mark.parametrize("layers", [1, 2, 3, 4])
def test_monotonic_ink_coverage(pattern, layers):
    means = []
    for step in range(11):
        t = step / 10.0
        value = round((1.0 - t) * 255)
        img = _flat(value)
        out = hatch(img, {"pattern": pattern, "layers": layers})
        # Default ink is black, paper white -> mean darkness is a direct
        # proxy for ink coverage.
        coverage = 1.0 - out[..., 0].mean() / 255.0
        means.append(coverage)

    assert all(means[i] <= means[i + 1] + 1e-9 for i in range(len(means) - 1))


# --- layers arrive in order ----------------------------------------------------


def test_layers_arrive_in_order_only_layer_0_at_t_0_2():
    value = round((1.0 - 0.2) * 255)
    img = _flat(value)

    out = hatch(img, {"pattern": "lines", "angle": 0, "layers": 4})

    for row in range(out.shape[0]):
        assert np.all(out[row, :, :3] == out[row, 0, :3])


def test_layers_arrive_in_order_layer_1_present_at_t_0_3():
    value = round((1.0 - 0.3) * 255)
    img = _flat(value)

    out = hatch(img, {"pattern": "lines", "angle": 0, "layers": 4})

    rows_uniform = all(
        np.all(out[row, :, :3] == out[row, 0, :3]) for row in range(out.shape[0])
    )
    assert not rows_uniform


# --- one layer engraves --------------------------------------------------------


@pytest.mark.parametrize("t_step", [0.2, 0.5, 0.8])
def test_one_layer_engraves_rows_uniform(t_step):
    value = round((1.0 - t_step) * 255)
    img = _flat(value)

    out = hatch(img, {"pattern": "lines", "layers": 1, "angle": 0})

    for row in range(out.shape[0]):
        assert np.all(out[row, :, :3] == out[row, 0, :3])


def test_one_layer_engraves_inked_row_count_grows_with_darkness():
    counts = []
    for t_step in (0.2, 0.4, 0.6, 0.8):
        value = round((1.0 - t_step) * 255)
        img = _flat(value)
        out = hatch(img, {"pattern": "lines", "layers": 1, "angle": 0})
        inked_rows = int(np.sum(np.any(out[:, :, :3] < 255, axis=(1, 2))))
        counts.append(inked_rows)

    assert all(counts[i] <= counts[i + 1] for i in range(len(counts) - 1))
    assert counts[0] < counts[-1]


# --- source -------------------------------------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
def test_source_red_and_green(pattern):
    img = np.zeros((16, 16, 4), dtype=np.uint8)
    img[..., 0] = 0
    img[..., 1] = 255
    img[..., 2] = 255
    img[..., 3] = 255

    out_red = hatch(img, {"pattern": pattern, "source": "red"})
    out_green = hatch(img, {"pattern": pattern, "source": "green"})

    assert np.all(out_red[..., :3] == 0)
    assert np.all(out_green[..., :3] == 255)


# --- levels ---------------------------------------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
def test_levels_grey_100_black_128_is_all_ink(pattern):
    img = _flat(100)

    out = hatch(img, {"pattern": pattern, "black": 128.0})

    assert np.all(out[..., :3] == 0)


def test_levels_white_leq_black_does_not_raise():
    img = _flat(100)

    out = hatch(img, {"black": 128.0, "white": 50.0})

    assert out.shape == img.shape


# --- paper as alpha ---------------------------------------------------------------


def test_paper_is_alpha_white_input_alpha_zero():
    img = _flat(255)

    out = hatch(img, {"paper_is_alpha": True})

    assert np.all(out[..., 3] == 0)


def test_paper_is_alpha_black_input_alpha_equals_input_alpha():
    img = _flat(0)
    img[..., 3] = 200

    out = hatch(img, {"paper_is_alpha": True, "weight": 1.0})

    assert np.all(out[..., 3] == 200)


def test_paper_is_alpha_rgb_is_ink_wherever_alpha_positive():
    img = _flat(0)
    img[..., 3] = 200

    out = hatch(img, {"paper_is_alpha": True, "weight": 1.0})

    mask = out[..., 3] > 0
    assert np.all(out[mask][..., :3] == np.array([0, 0, 0], dtype=np.uint8))


def test_paper_is_alpha_false_alpha_equals_input_alpha_exactly():
    rng = np.random.default_rng(30)
    img = _random_rgba(rng, h=20, w=20)

    out = hatch(img, {"paper_is_alpha": False})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


# --- determinism -----------------------------------------------------------------


def test_dashes_deterministic_same_params():
    rng = np.random.default_rng(31)
    img = _random_rgba(rng)
    params = {"pattern": "dashes", "seed": 5}

    first = hatch(img, params)
    second = hatch(img, params)

    np.testing.assert_array_equal(first, second)


def test_dashes_different_seed_differs():
    rng = np.random.default_rng(32)
    img = _random_rgba(rng)

    a = hatch(img, {"pattern": "dashes", "seed": 5})
    b = hatch(img, {"pattern": "dashes", "seed": 6})

    assert not np.array_equal(a, b)


def test_lines_ignores_seed():
    rng = np.random.default_rng(33)
    img = _random_rgba(rng)

    a = hatch(img, {"pattern": "lines", "seed": 5})
    b = hatch(img, {"pattern": "lines", "seed": 6})

    np.testing.assert_array_equal(a, b)


# --- translation stability --------------------------------------------------------


def test_translation_stability():
    rng = np.random.default_rng(34)
    h, w = 24, 30
    pad = 10
    img = _random_rgba(rng, h=h, w=w)

    padded = np.zeros((h + pad, w + pad, 4), dtype=np.uint8)
    padded[:h, :w] = img
    padded[h:, :] = rng.integers(0, 256, size=(pad, w + pad, 4), dtype=np.uint8)
    padded[:, w:] = rng.integers(0, 256, size=(h + pad, pad, 4), dtype=np.uint8)

    params = {"pattern": "dashes", "seed": 7, "angle": 30}
    out_img = hatch(img, params)
    out_padded = hatch(padded, params)[:h, :w]

    np.testing.assert_array_equal(out_img, out_padded)


# --- one spatial param -------------------------------------------------------------


def test_only_spacing_is_spatial():
    params = OPS["hatch"].to_dict()["params"]
    spatial = {p["name"] for p in params if p["scale"] == "spatial"}

    assert spatial == {"spacing"}


# --- garbage colour ------------------------------------------------------------------


def test_garbage_ink_colour_falls_back_to_black():
    rng = np.random.default_rng(35)
    img = _random_rgba(rng)

    default_out = hatch(img, {})
    garbage_out = hatch(img, {"ink": "not a colour"})

    np.testing.assert_array_equal(default_out, garbage_out)


# --- helpers: _area, _hash01 ----------------------------------------------------------


def test_area_is_zero_at_zero_half_width():
    d = np.array([0.0, 0.5, 1.0, 5.0])
    h = np.zeros_like(d)

    assert np.all(_area(d, h) == 0.0)


def test_area_covers_full_period_at_overdriven_half_width():
    spacing = 8.0
    d = np.linspace(0.0, spacing / 2.0, 50)
    h = np.full_like(d, (spacing + 1.0) / 2.0)

    np.testing.assert_allclose(_area(d, h), 1.0)


def test_hash01_is_stateless_and_shape_independent():
    n = np.array([-3, 0, 5, 100], dtype=np.int64)

    a = _hash01(n, 2, 7)
    b = _hash01(n, 2, 7)
    np.testing.assert_array_equal(a, b)

    # Same integers, differently shaped/packed call -> same per-element
    # result (a table indexed by position would fail this).
    single = np.array([n[2]], dtype=np.int64)
    c = _hash01(single, 2, 7)
    assert c[0] == a[2]


def test_hash01_in_unit_interval():
    n = np.arange(-50, 50, dtype=np.int64)

    out = _hash01(n, 1, 3)

    assert np.all(out >= 0.0)
    assert np.all(out < 1.0)
