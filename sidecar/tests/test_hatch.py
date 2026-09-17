"""Semantic tests for `hatch` (epic 18: story 1 — tone model, `lines` and
`dashes`; story 2 — the cell-based `crosses` and `stipple`). `PATTERNS`
is deliberately a module-level tuple so story 2 extends the shared
battery by appending to it rather than duplicating every test.
"""

from __future__ import annotations

import hashlib
import time

import numpy as np
import pytest

from ops import OPS
from ops.hatch import _area, _bar_offsets, _hash01, hatch

PATTERNS = ("lines", "dashes", "crosses", "stipple")

# Cell-based patterns (`crosses`/`stipple`) clamp their cell-centre tone
# lookup to the image bounds (story 2 doc, "Lattice"), so cells within
# `2 * spacing` of the right/bottom edges can legitimately differ from the
# same region in a padded image. Tests that rely on every-pixel identity
# across image sizes (translation stability) compare only the interior
# for these patterns.
_CELL_PATTERNS = ("crosses", "stipple")


def _flat(value: int, h: int = 40, w: int = 40) -> np.ndarray:
    return np.full((h, w, 4), value, dtype=np.uint8)


def _random_rgba(rng: np.random.Generator, h: int = 24, w: int = 32) -> np.ndarray:
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)


# --- story 1 regression: byte-identical `lines`/`dashes` output ---------------
#
# Pinned before story 2 touched `hatch.py` at all, on a fixed 64x48 seeded
# RGBA image (`np.random.default_rng(42)`), `layers=3, angle=30, seed=7`.
# Story 2 restructures the per-layer coverage machinery to share it with the
# new cell patterns; these digests guard that `lines`/`dashes` output cannot
# drift as a side effect.

_STORY_1_REGRESSION_DIGESTS = {
    "lines": "7e54312079f98f974a7e8a73e70bfde0f6ad7a768446662e26987ab7cf7f02f9",
    "dashes": "8524a41065c595953424f2c136c6631bd7f55f477edee625c8ff12dfc25167d7",
}


@pytest.mark.parametrize("pattern", ("lines", "dashes"))
def test_story_1_output_byte_identical_regression(pattern):
    rng = np.random.default_rng(42)
    img = rng.integers(0, 256, size=(48, 64, 4), dtype=np.uint8)

    out = hatch(img, {"pattern": pattern, "layers": 3, "angle": 30, "seed": 7})

    digest = hashlib.sha256(out.tobytes()).hexdigest()
    assert digest == _STORY_1_REGRESSION_DIGESTS[pattern]


# --- story 7 regression: byte-identical lattice-hashing refactor --------------
#
# Recorded from `hatch.py` at HEAD *before* story 7 touched it, on a fixed
# 256x256 seeded RGBA image (`np.random.default_rng(99)`). Story 7 moves every
# hashed/looked-up quantity that is a function of lattice indices only (the
# wobble hash, the dash phase hash, the stipple hashes, `_cell_centre_tone`,
# `_c_k`, `_jitter_fade` inside `_crosses_ink_sweep`) onto a compact grid
# evaluated once and gathered per pixel — a pure performance change, so every
# digest here must still match after the refactor (story doc, "Acceptance").

_STORY_7_REGRESSION_DIGESTS = {
    "lines_layers1_jitter0.0": "6f0e84aceea0d1e97c90f3059f176008b3f6d771aeb98bc5bba11aec1aedc98d",
    "lines_layers1_jitter0.5": "1f3dc1bb1abdbf6b399396def22da507bdabc51f34ab668b35e276aee1798efc",
    "lines_layers4_jitter0.0": "9c01606296a9e5a55d9e10c84f9cf8b4e70240309f8b0a01ea856df973a1e31a",
    "lines_layers4_jitter0.5": "a0c42186b66637e857d6eea83dcc36d3c1297c5706c61822d11824278df79a64",
    "dashes_layers1_jitter0.0": "354d3c8c0c032c7b97f79ec9343d7274aa51b784edbf4ccc67ab23315b687337",
    "dashes_layers1_jitter0.5": "46f8d62c28057bcd0f6a14aa2ade5982906910cfd8847e8832dec950525848f7",
    "dashes_layers4_jitter0.0": "3422482b1594f778a3f40f24c48796eecb6fd7df4a575b3ae48b8e8472384e07",
    "dashes_layers4_jitter0.5": "8092e65c7f239dc1c2fe4b3f0d41678c2d142a1f524880e0c23dab09d099b03e",
    "crosses_layers1_jitter0.0": "7690abe90d8be2950fb66dff9a9844713ee90678d2fee8bb49681f4a2212de98",
    "crosses_layers1_jitter0.5": "a84cea498831c4485f73162eb53797bdca4e776fb8006e0952b7efac621b6126",
    "crosses_layers4_jitter0.0": "3ab835b5f5ef77373f614c946809a897a5bc35926d404c1ba10e673d88f25162",
    "crosses_layers4_jitter0.5": "1d3041fb89f6160d701077439b11d3942cbf56e261f0fad167893e4f036be0a4",
    "stipple_layers1_jitter0.0": "d3152c64f1816a0d5401c17f1a7122bb315d85f4681d1ad5d9d81c33d7371e21",
    "stipple_layers1_jitter0.5": "d3152c64f1816a0d5401c17f1a7122bb315d85f4681d1ad5d9d81c33d7371e21",
    "stipple_layers4_jitter0.0": "1fe21ed2626dcf2fad264f12dc64c6bd39ecc2ef7174a7289dacce58b7457e51",
    "stipple_layers4_jitter0.5": "1fe21ed2626dcf2fad264f12dc64c6bd39ecc2ef7174a7289dacce58b7457e51",
    "crosses_cross_size2": "a999ec84ef98bcbf65515ad0a273a31c8e4249ce9ab63190ef7d9efe700135b5",
    "crosses_cross_size2_aspect2_jitter0.5": "2c7750608b982048f7c421ae4322283325c6af1d71010f43476ed17f71f4b954",
    "dashes_seed7": "4676581860bad3b4fef22fa40cbe8b611073ad13c430c0f4f75eeca986eb3d12",
    "stipple_seed7": "be8e7bcae964faec4d1d52cfbd2e0d0083977221629cf0031eafaf72fd0e65ee",
}


def _story_7_input() -> np.ndarray:
    rng = np.random.default_rng(99)
    return rng.integers(0, 256, size=(256, 256, 4), dtype=np.uint8)


@pytest.mark.parametrize("pattern", PATTERNS)
@pytest.mark.parametrize("layers", (1, 4))
@pytest.mark.parametrize("jitter", (0.0, 0.5))
def test_story_7_output_byte_identical_regression_matrix(pattern, layers, jitter):
    img = _story_7_input()

    out = hatch(img, {"pattern": pattern, "layers": layers, "jitter": jitter})

    digest = hashlib.sha256(out.tobytes()).hexdigest()
    key = f"{pattern}_layers{layers}_jitter{jitter}"
    assert digest == _STORY_7_REGRESSION_DIGESTS[key]


def test_story_7_output_byte_identical_regression_crosses_cross_size():
    img = _story_7_input()

    out = hatch(img, {"pattern": "crosses", "cross_size": 2.0})

    digest = hashlib.sha256(out.tobytes()).hexdigest()
    assert digest == _STORY_7_REGRESSION_DIGESTS["crosses_cross_size2"]


def test_story_7_output_byte_identical_regression_crosses_cross_size_aspect_jitter():
    img = _story_7_input()

    out = hatch(
        img,
        {
            "pattern": "crosses",
            "cross_size": 2.0,
            "cross_aspect": 2.0,
            "jitter": 0.5,
        },
    )

    digest = hashlib.sha256(out.tobytes()).hexdigest()
    assert (
        digest == _STORY_7_REGRESSION_DIGESTS["crosses_cross_size2_aspect2_jitter0.5"]
    )


@pytest.mark.parametrize("pattern", ("dashes", "stipple"))
def test_story_7_output_byte_identical_regression_seed(pattern):
    img = _story_7_input()

    out = hatch(img, {"pattern": pattern, "seed": 7})

    digest = hashlib.sha256(out.tobytes()).hexdigest()
    assert digest == _STORY_7_REGRESSION_DIGESTS[f"{pattern}_seed7"]


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


# --- disabled_when annotations (Epic 18 story 5) ---------------------------


def test_to_dict_emits_the_five_disabled_when_conditions():
    # Story 6 drops `seed`'s `disabled_when` (`lines`/`crosses` read it once
    # `jitter > 0`, and a compound condition isn't worth adding for one
    # slider) and adds `jitter`'s own — the count stays five.
    params_by_name = {p["name"]: p for p in OPS["hatch"].to_dict()["params"]}

    assert params_by_name["pen"]["disabledWhen"] == {
        "path": "pattern",
        "equals": "stipple",
    }
    assert params_by_name["jitter"]["disabledWhen"] == {
        "path": "pattern",
        "equals": "stipple",
    }
    assert params_by_name["cross_size"]["disabledWhen"] == {
        "path": "pattern",
        "notEquals": "crosses",
    }
    assert params_by_name["cross_aspect"]["disabledWhen"] == {
        "path": "pattern",
        "notEquals": "crosses",
    }
    assert params_by_name["paper"]["disabledWhen"] == {
        "path": "paper_is_alpha",
        "equals": True,
    }

    assert "disabledWhen" not in params_by_name["seed"]

    # Every other param is untouched by this story.
    untouched = set(params_by_name) - {
        "pen",
        "jitter",
        "cross_size",
        "cross_aspect",
        "paper",
    }
    for name in untouched:
        assert "disabledWhen" not in params_by_name[name]


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


@pytest.mark.parametrize("pattern", PATTERNS)
def test_translation_stability(pattern):
    rng = np.random.default_rng(34)
    h, w = 40, 48
    pad = 12
    spacing = 8.0
    img = _random_rgba(rng, h=h, w=w)

    padded = np.zeros((h + pad, w + pad, 4), dtype=np.uint8)
    padded[:h, :w] = img
    padded[h:, :] = rng.integers(0, 256, size=(pad, w + pad, 4), dtype=np.uint8)
    padded[:, w:] = rng.integers(0, 256, size=(h + pad, pad, 4), dtype=np.uint8)

    params = {"pattern": pattern, "seed": 7, "angle": 30, "spacing": spacing}
    out_img = hatch(img, params)
    out_padded = hatch(padded, params)[:h, :w]

    if pattern in _CELL_PATTERNS:
        # Cell patterns clamp their cell-centre lookup to the image
        # bounds, so cells within 2 * spacing of the right/bottom edges
        # can legitimately differ (story 2 doc, "Acceptance").
        margin = int(2 * spacing)
        np.testing.assert_array_equal(
            out_img[: h - margin, : w - margin],
            out_padded[: h - margin, : w - margin],
        )
    else:
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


# --- crosses and stipple (story 2) ------------------------------------------------


def _cells(out_rgb: np.ndarray, margin: int, cell: int) -> np.ndarray:
    """Reshape an interior crop of `out_rgb` (cropped by `margin` on every
    side so cell boundaries land on `cell`-px multiples) into one block per
    lattice cell, `(rows, cell, cols, cell, 3)`."""
    h, w = out_rgb.shape[:2]
    cropped = out_rgb[margin : h - margin, margin : w - margin]
    rows, cols = cropped.shape[0] // cell, cropped.shape[1] // cell
    cropped = cropped[: rows * cell, : cols * cell]
    return cropped.reshape(rows, cell, cols, cell, 3)


def test_crosses_cell_centre_inked_corner_paper():
    # t ~= 0.498 (flat grey 128), layers=1 -> c_0 ~= 0.498, the arm-growth
    # phase (c <= 0.5). Cell centres sit at multiples of `spacing` when
    # angle=0 and layer 0's lattice offset is (0, 0).
    img = _flat(128, h=64, w=64)

    out = hatch(img, {"pattern": "crosses", "layers": 1, "angle": 0, "spacing": 16.0})

    assert np.all(out[0, 0, :3] == 0)
    assert np.all(out[8, 8, :3] == 255)


def test_crosses_x_orientation_reaches_further_than_plus_on_the_diagonal():
    # `+` (k=0, offset (0,0), centre at (0,0)) and `x` (k=1, offset
    # (1/2, 1/2), centre at (8,8)) have different geometry constants
    # (story 2 doc, "crosses" — reach S/2 vs S/root2, W S/2+0.5 vs
    # S/(2*root2)+0.5): the `x` mark's arm runs along the diagonal, so it
    # reaches a diagonal offset the `+` mark's (axis-aligned) arms can't,
    # at the same coverage. `t=0.6` puts both layers' arms in the growth
    # phase (c <= 0.5).
    img = _flat(round((1.0 - 0.6) * 255), h=64, w=64)

    out = hatch(img, {"pattern": "crosses", "layers": 2, "angle": 0, "spacing": 16.0})

    assert np.all(out[3, 3, :3] == 255)  # `+` centre (0, 0), diagonal offset
    assert np.any(out[11, 11, :3] < 255)  # `x` centre (8, 8), same offset


def test_stipple_sparse_in_the_light():
    value = round((1.0 - 0.1) * 255)
    img = _flat(value, h=80, w=80)
    spacing = 8

    out_a = hatch(
        img, {"pattern": "stipple", "layers": 1, "spacing": float(spacing), "seed": 1}
    )
    out_b = hatch(
        img, {"pattern": "stipple", "layers": 1, "spacing": float(spacing), "seed": 2}
    )

    margin = spacing // 2
    cells_a = _cells(out_a[..., :3], margin, spacing)
    cells_b = _cells(out_b[..., :3], margin, spacing)
    inked_a = np.any(cells_a < 255, axis=(1, 3, 4))
    inked_b = np.any(cells_b < 255, axis=(1, 3, 4))

    assert 0 < inked_a.mean() < 1
    assert not np.array_equal(inked_a, inked_b)


def test_stipple_whole_in_the_dark():
    value = round((1.0 - 0.6) * 255)
    img = _flat(value, h=80, w=80)
    spacing = 8

    out = hatch(
        img, {"pattern": "stipple", "layers": 1, "spacing": float(spacing), "seed": 1}
    )

    margin = spacing // 2
    cells = _cells(out[..., :3], margin, spacing)
    inked = np.any(cells < 255, axis=(1, 3, 4))

    assert inked.all()


def test_crosses_ignore_seed():
    img = _flat(128, h=64, w=64)

    a = hatch(img, {"pattern": "crosses", "seed": 1})
    b = hatch(img, {"pattern": "crosses", "seed": 2})

    np.testing.assert_array_equal(a, b)


# --- pen: the widest a stroke gets -----------------------------------------------------

_STROKE_PATTERNS = ("lines", "dashes", "crosses")


@pytest.mark.parametrize("pattern", PATTERNS)
def test_pen_one_is_the_uncapped_op(pattern):
    rng = np.random.default_rng(51)
    img = _random_rgba(rng)
    params = {"pattern": pattern, "layers": 3, "angle": 30, "seed": 7}

    a = hatch(img, params)
    b = hatch(img, {**params, "pen": 1.0})

    np.testing.assert_array_equal(a, b)


@pytest.mark.parametrize("pattern", _STROKE_PATTERNS)
def test_pen_below_one_stays_open(pattern):
    img = _flat(0)

    out = hatch(img, {"pattern": pattern, "pen": 0.2, "seed": 7})

    assert np.any(np.all(out[..., :3] == 255, axis=-1))


def test_pen_caps_line_ink_per_period():
    # Black, one layer, horizontal lines: every stroke is at full coverage,
    # so its half-width is exactly `pen * (S + 1) / 2` and the period holds
    # `pen * (S + 1)` px of ink. 40 rows is five whole periods of 8.
    img = _flat(0)
    spacing, pen = 8.0, 0.25

    out = hatch(img, {"layers": 1, "angle": 0, "spacing": spacing, "pen": pen})

    ink = 1.0 - out[..., 0].mean() / 255.0
    assert ink == pytest.approx(pen * (spacing + 1.0) / spacing, abs=0.01)


@pytest.mark.parametrize("pattern", _STROKE_PATTERNS)
@pytest.mark.parametrize("layers", [1, 4])
def test_pen_keeps_ink_coverage_monotonic(pattern, layers):
    means = []
    for step in range(11):
        value = round((1.0 - step / 10.0) * 255)
        out = hatch(_flat(value), {"pattern": pattern, "layers": layers, "pen": 0.2})
        means.append(1.0 - out[..., 0].mean() / 255.0)

    assert all(means[i] <= means[i + 1] + 1e-9 for i in range(len(means) - 1))


def test_pen_crosses_arms_reach_full_length_as_hairlines():
    # Black, one layer of `+` at angle 0: arms at full reach join their
    # neighbours into a continuous row through the cell centres, while the
    # capped bars leave the row between them mostly paper.
    img = _flat(0, h=64, w=64)
    spacing = 16

    out = hatch(
        img,
        {
            "pattern": "crosses",
            "layers": 1,
            "angle": 0,
            "spacing": spacing,
            "pen": 0.1,
        },
    )

    assert np.all(out[spacing, :, :3] == 0)
    assert np.mean(out[spacing // 2, :, 0] == 255) > 0.5


def test_stipple_ignores_pen():
    img = _flat(128, h=64, w=64)

    a = hatch(img, {"pattern": "stipple", "seed": 3})
    b = hatch(img, {"pattern": "stipple", "seed": 3, "pen": 0.1})

    np.testing.assert_array_equal(a, b)


# --- cross shape (story 4) ---------------------------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
def test_cross_size_and_aspect_one_is_the_uncapped_op(pattern):
    rng = np.random.default_rng(52)
    img = _random_rgba(rng)
    params = {"pattern": pattern, "layers": 3, "angle": 30, "seed": 7}

    a = hatch(img, params)
    b = hatch(img, {**params, "cross_size": 1.0, "cross_aspect": 1.0})

    np.testing.assert_array_equal(a, b)


@pytest.mark.parametrize("pattern", ("lines", "dashes", "stipple"))
def test_cross_size_and_aspect_ignored_outside_crosses(pattern):
    rng = np.random.default_rng(53)
    img = _random_rgba(rng)
    params = {"pattern": pattern, "seed": 3}

    a = hatch(img, params)
    b = hatch(img, {**params, "cross_size": 2.5, "cross_aspect": 3.0})

    np.testing.assert_array_equal(a, b)


def test_cross_aspect_stretches_one_bar():
    # t ~= 0.25 (flat grey, round(0.75*255)), layers=1, angle=0, S=16:
    # [16, 22] and [22, 16] are both 6 px along a `+` bar from the cell
    # centre (16, 16) at defaults -> paper. At cross_aspect=2 bar1 (along
    # p, the `du` axis) reaches 6 px while bar2 (along r) doesn't (story 4
    # doc, "Acceptance").
    img = _flat(round((1.0 - 0.25) * 255), h=64, w=64)
    params = {"pattern": "crosses", "layers": 1, "angle": 0, "spacing": 16.0}

    out_default = hatch(img, params)
    assert np.all(out_default[16, 22, :3] == 255)
    assert np.all(out_default[22, 16, :3] == 255)

    out_aspect = hatch(img, {**params, "cross_aspect": 2.0})
    assert np.all(out_aspect[16, 22, :3] == 0)
    assert np.all(out_aspect[22, 16, :3] == 255)


def test_cross_size_bleeds_into_lighter_neighbour():
    # 64x96, columns 0..39 black, the rest white, crosses, layers=1,
    # angle=0, S=16: at defaults the first all-white cell's centre (16,
    # 48) is paper. At cross_size=2, the arm reaching out from the black
    # cell at column 32 (offset (-1, 0) from the white cell) reaches it
    # (story 4 doc, "Acceptance").
    img = np.zeros((64, 96, 4), dtype=np.uint8)
    img[:, 40:] = 255
    img[..., 3] = 255
    params = {"pattern": "crosses", "layers": 1, "angle": 0, "spacing": 16.0}

    out_default = hatch(img, params)
    assert np.all(out_default[16, 48, :3] == 255)

    out_size = hatch(img, {**params, "cross_size": 2.0})
    assert np.all(out_size[16, 48, :3] == 0)


@pytest.mark.parametrize("layers", [1, 4])
@pytest.mark.parametrize("angle", [0, 30])
@pytest.mark.parametrize("spacing", [6, 16])
def test_cross_size_black_closes_at_large_sizes(layers, angle, spacing):
    img = _flat(0, h=64, w=64)

    out = hatch(
        img,
        {
            "pattern": "crosses",
            "layers": layers,
            "angle": angle,
            "spacing": spacing,
            "cross_size": 2.0,
            "cross_aspect": 3.0,
            "seed": 7,
        },
    )

    assert np.all(out[..., :3] == 0)


def test_small_crosses_stay_open():
    img = _flat(0)

    out = hatch(img, {"pattern": "crosses", "cross_size": 0.5})

    assert np.any(np.all(out[..., :3] == 255, axis=-1))


@pytest.mark.parametrize("layers", [1, 4])
def test_cross_size_and_aspect_keep_ink_coverage_monotonic(layers):
    means = []
    for step in range(11):
        value = round((1.0 - step / 10.0) * 255)
        out = hatch(
            _flat(value),
            {
                "pattern": "crosses",
                "layers": layers,
                "cross_size": 2.0,
                "cross_aspect": 2.0,
            },
        )
        means.append(1.0 - out[..., 0].mean() / 255.0)

    assert all(means[i] <= means[i + 1] + 1e-9 for i in range(len(means) - 1))


def test_bar_offsets_single_cell_at_f_one():
    # `+` (k=0), pen=1, f=1: bar1's arm exactly reaches its own cell edge
    # and no further (story 4 doc, "Offset selection", "Acceptance").
    offsets = _bar_offsets(0, 1, 1.0, 1.0, 16.0)

    assert offsets == [(0, 0)]


def test_bar_offsets_sweep_includes_along_axis_excludes_across():
    # `+` (k=0), pen=1, f=2: bar1 runs along p (the `du`/(1, 0) axis), so
    # its arm reaches the neighbours at (-1, 0)/(1, 0) but not (0, -1)/
    # (0, 1) (story 4 doc, "Acceptance").
    offsets = set(_bar_offsets(0, 1, 2.0, 1.0, 16.0))

    assert {(-1, 0), (0, 0), (1, 0)} <= offsets
    assert (0, 1) not in offsets
    assert (0, -1) not in offsets


# --- jitter (story 6) --------------------------------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
def test_jitter_zero_is_the_unjittered_op(pattern):
    rng = np.random.default_rng(54)
    img = _random_rgba(rng)
    params = {"pattern": pattern, "layers": 3, "angle": 30, "seed": 7}

    a = hatch(img, params)
    b = hatch(img, {**params, "jitter": 0.0})

    np.testing.assert_array_equal(a, b)


def test_stipple_ignores_jitter():
    img = _flat(128, h=64, w=64)

    a = hatch(img, {"pattern": "stipple", "seed": 3})
    b = hatch(img, {"pattern": "stipple", "seed": 3, "jitter": 1.0})

    np.testing.assert_array_equal(a, b)


@pytest.mark.parametrize("pattern", ("lines", "dashes", "crosses"))
def test_jitter_moves_the_mark_and_reads_seed(pattern):
    # Flat mid-grey (t = 0.3, story 6 doc "It moves").
    value = round((1.0 - 0.3) * 255)
    img = _flat(value, h=64, w=64)
    params = {"pattern": pattern, "seed": 1}

    unjittered = hatch(img, params)
    jittered = hatch(img, {**params, "jitter": 1.0})
    assert not np.array_equal(unjittered, jittered)

    other_seed = hatch(img, {**params, "jitter": 1.0, "seed": 2})
    assert not np.array_equal(jittered, other_seed)


def test_lines_wobble_smoothly_along_the_stroke():
    # One layer of horizontal lines (angle=0, layers=1, pen=0.2, S=16,
    # jitter=1, flat t=0.3, 64x256): each inked stroke's centroid row,
    # measured per column, varies by more than 2 px along the image but by
    # less than 1 px between adjacent columns (story 6 doc, "Acceptance").
    value = round((1.0 - 0.3) * 255)
    h, w = 64, 256
    img = _flat(value, h=h, w=w)

    out = hatch(
        img,
        {
            "pattern": "lines",
            "layers": 1,
            "angle": 0,
            "pen": 0.2,
            "spacing": 16.0,
            "jitter": 1.0,
        },
    )

    # Isolate the stroke nominally centred on row 32 — a band that spans
    # its full jitter range (+/- S/2) while staying clear of its
    # neighbours at rows 16 and 48, so their ink can't blend into this
    # stroke's centroid.
    band = out[24:40, :, 0].astype(np.float64)
    ink = 255.0 - band
    rows = np.arange(24, 40)[:, None]
    total = ink.sum(axis=0)
    assert np.all(total > 0)
    centroid = (rows * ink).sum(axis=0) / total

    assert centroid.max() - centroid.min() > 2.0
    assert np.all(np.abs(np.diff(centroid)) < 1.0)


@pytest.mark.parametrize("pattern", ("lines", "dashes", "crosses"))
@pytest.mark.parametrize("layers", [1, 4])
@pytest.mark.parametrize("angle", [0, 30])
@pytest.mark.parametrize("spacing", [6, 16])
def test_jitter_black_closes_to_ink_no_pinholes(pattern, layers, angle, spacing):
    img = _flat(0)

    out = hatch(
        img,
        {
            "pattern": pattern,
            "layers": layers,
            "weight": 1.0,
            "angle": angle,
            "spacing": spacing,
            "jitter": 1.0,
            "seed": 7,
        },
    )

    assert np.all(out[..., :3] == 0)


@pytest.mark.parametrize("pattern", ("lines", "dashes", "crosses"))
@pytest.mark.parametrize("layers", [1, 4])
def test_jitter_keeps_ink_coverage_monotonic(pattern, layers):
    means = []
    for step in range(11):
        value = round((1.0 - step / 10.0) * 255)
        out = hatch(
            _flat(value),
            {"pattern": pattern, "layers": layers, "jitter": 1.0, "seed": 7},
        )
        means.append(1.0 - out[..., 0].mean() / 255.0)

    assert all(means[i] <= means[i + 1] + 1e-9 for i in range(len(means) - 1))


@pytest.mark.parametrize("pattern", PATTERNS)
def test_jitter_translation_stability(pattern):
    rng = np.random.default_rng(34)
    h, w = 40, 48
    pad = 12
    spacing = 8.0
    img = _random_rgba(rng, h=h, w=w)

    padded = np.zeros((h + pad, w + pad, 4), dtype=np.uint8)
    padded[:h, :w] = img
    padded[h:, :] = rng.integers(0, 256, size=(pad, w + pad, 4), dtype=np.uint8)
    padded[:, w:] = rng.integers(0, 256, size=(h + pad, pad, 4), dtype=np.uint8)

    params = {
        "pattern": pattern,
        "seed": 7,
        "angle": 30,
        "spacing": spacing,
        "jitter": 1.0,
    }
    out_img = hatch(img, params)
    out_padded = hatch(padded, params)[:h, :w]

    if pattern == "crosses":
        # `crosses`' own-cell displacement can reach D = jitter * S / 2
        # beyond the existing 2 * S cell-centre-lookup margin (story 6
        # doc, "Acceptance"); `stipple` ignores `jitter` outright, so its
        # margin is unchanged.
        margin = int(2 * spacing + spacing / 2.0)
        np.testing.assert_array_equal(
            out_img[: h - margin, : w - margin],
            out_padded[: h - margin, : w - margin],
        )
    elif pattern == "stipple":
        margin = int(2 * spacing)
        np.testing.assert_array_equal(
            out_img[: h - margin, : w - margin],
            out_padded[: h - margin, : w - margin],
        )
    else:
        np.testing.assert_array_equal(out_img, out_padded)


def test_bar_offsets_pad_grows_own_cell_half_extent():
    # `+` (k=0), pen=1, f=1, pad=S/2: the own cell's half-extent grows from
    # S/2 to S, so bar1's arm (which exactly reaches the unpadded cell
    # edge and no further, `test_bar_offsets_single_cell_at_f_one`) now
    # also reaches the diagonal and across-axis neighbours (story 6 doc,
    # "`crosses`: per-cell offset", "Acceptance").
    offsets = set(_bar_offsets(0, 1, 1.0, 1.0, 16.0, pad=8.0))

    assert {(1, 0), (-1, 0), (0, 1), (0, -1)} <= offsets

    offsets_unpadded = _bar_offsets(0, 1, 1.0, 1.0, 16.0, pad=0.0)
    assert offsets_unpadded == [(0, 0)]


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


# --- perf smoke (story 7) -----------------------------------------------------


@pytest.mark.perf
def test_crosses_jitter_2048_well_under_two_and_a_half_seconds():
    """Perf smoke test (story 7 doc, "Acceptance") — the pre-story-7 op
    measured 5.13s here (story doc's table); the lattice-hashing/gather
    refactor must land it well under 2.5s. Marked `perf`, skipped by
    default per `pyproject.toml`'s `-m 'not perf'`; run explicitly with
    `-m perf`."""
    img = np.random.default_rng(0).integers(0, 256, (2048, 2048, 4), dtype=np.uint8)
    params = {"pattern": "crosses", "layers": 4, "jitter": 0.5}

    hatch(img, params)  # warm up
    start = time.perf_counter()
    hatch(img, params)
    elapsed = time.perf_counter() - start

    assert elapsed < 2.5, f"crosses jitter=0.5 took {elapsed:.3f}s on a 2048x2048 image"


@pytest.mark.perf
def test_lines_jitter_2048_well_under_half_a_second():
    """Perf smoke test (story 7 doc, "Acceptance") — the pre-story-7 op
    measured 1.17s here (story doc's table); the lattice-hashing/gather
    refactor must land it well under 0.5s. Marked `perf`, skipped by
    default per `pyproject.toml`'s `-m 'not perf'`; run explicitly with
    `-m perf`."""
    img = np.random.default_rng(0).integers(0, 256, (2048, 2048, 4), dtype=np.uint8)
    params = {"pattern": "lines", "layers": 4, "jitter": 0.5}

    hatch(img, params)  # warm up
    start = time.perf_counter()
    hatch(img, params)
    elapsed = time.perf_counter() - start

    assert elapsed < 0.5, f"lines jitter=0.5 took {elapsed:.3f}s on a 2048x2048 image"
