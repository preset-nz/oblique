"""`technicolor` — dye-transfer colour with seeded record fringing. Same
conventions as `test_colour_keep.py`.
"""

from __future__ import annotations

import numpy as np
import pytest
from ops import OPS
from ops.technicolor import _record_offsets, _shift_record, technicolor

BLUE = (0, 0, 255)


def _random_rgba(rng: np.random.Generator, h: int = 24, w: int = 32) -> np.ndarray:
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)


def _solid(rgb: tuple[int, int, int], h: int = 8, w: int = 8, alpha: int = 255):
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., :3] = rgb
    img[..., 3] = alpha
    return img


def _step_edge(w: int, h: int = 4) -> np.ndarray:
    """Black on the left half, white on the right, edge at `w / 2`."""
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., 3] = 255
    img[:, w // 2 :, :3] = 255
    return img


# Dyes off, no bleed, full amount: the output is exactly the shifted records,
# so the fringe can be measured without the colour model in the way.
RECORDS_ONLY = {
    "process": "three_strip",
    "dye_density": 1.0,
    "cross_talk": 0.0,
    "amount": 1.0,
}


def _edge_positions(out: np.ndarray) -> np.ndarray:
    """Sub-pixel edge column per channel (R, G, B) from a row's coverage sum."""
    row = out[1, :, :3].astype(np.float64) / 255.0
    return out.shape[1] - row.sum(axis=0)


def test_registered_with_labelled_params_and_spatial_fringe():
    entry = OPS["technicolor"]
    assert entry.backend == "python"
    assert entry.writes_alpha is False
    params = {p["name"]: p for p in entry.to_dict()["params"]}
    assert list(params) == [
        "process",
        "dye_density",
        "cross_talk",
        "fringe",
        "amount",
        "seed",
    ]
    assert params["process"]["choices"] == ["two_strip", "three_strip"]
    for name in ("dye_density", "cross_talk", "fringe", "amount"):
        assert params[name]["widget"] == "slider"
    assert params["fringe"]["scale"] == "spatial"
    for name in ("process", "dye_density", "cross_talk", "amount", "seed"):
        assert params[name]["scale"] == "none"


@pytest.mark.parametrize("process", ["two_strip", "three_strip"])
def test_amount_zero_is_identity(process):
    img = _random_rgba(np.random.default_rng(0))
    out = technicolor(img, {"process": process, "amount": 0.0, "seed": 3})
    np.testing.assert_array_equal(out, img)


@pytest.mark.parametrize("process", ["two_strip", "three_strip"])
def test_deterministic(process):
    img = _random_rgba(np.random.default_rng(1))
    params = {"process": process, "fringe": 3.0, "seed": 9}
    np.testing.assert_array_equal(technicolor(img, params), technicolor(img, params))


def test_seed_changes_output_only_when_fringe_is_positive():
    img = _random_rgba(np.random.default_rng(2))
    aligned = {"fringe": 0.0}
    np.testing.assert_array_equal(
        technicolor(img, {**aligned, "seed": 1}),
        technicolor(img, {**aligned, "seed": 2}),
    )
    fringed = {"fringe": 3.0}
    assert not np.array_equal(
        technicolor(img, {**fringed, "seed": 1}),
        technicolor(img, {**fringed, "seed": 2}),
    )


def test_seed_moves_the_fringe_not_its_width():
    # Every seed's offsets stay inside the fringe radius.
    for seed in range(20):
        assert np.abs(_record_offsets(seed, 2.5)).max() <= 2.5


@pytest.mark.parametrize("process", ["two_strip", "three_strip"])
@pytest.mark.parametrize("level", [0, 30, 128, 200, 255])
def test_aligned_records_keep_a_neutral_grey_neutral(process, level):
    # Equal records give equal dyes and a row-stochastic cross-talk matrix
    # keeps them equal, so the channels can differ only by 8-bit rounding of
    # one shared float value: at most 1 level.
    img = _solid((level, level, level))
    for amount in (0.5, 1.0):
        out = technicolor(
            img,
            {"process": process, "fringe": 0.0, "cross_talk": 1.0, "amount": amount},
        )
        spread = out[..., :3].max(axis=-1).astype(int) - out[..., :3].min(axis=-1)
        assert spread.max() <= 1


def test_two_strip_has_no_strong_blue_on_pure_blue():
    img = _solid(BLUE)
    out = technicolor(img, {"process": "two_strip", "fringe": 0.0, "amount": 1.0})
    r, g, b = (int(out[0, 0, i]) for i in range(3))
    assert b < 140  # nowhere near the 255 that went in
    assert b <= g + 10  # blue no longer leads: it has collapsed to cyan-green
    assert r < 40
    # Three-strip, by contrast, keeps the blue.
    three = technicolor(img, {"process": "three_strip", "fringe": 0.0, "amount": 1.0})
    assert three[0, 0, 2] > 200
    assert three[0, 0, 2] > three[0, 0, 1] + 100


def test_three_strip_and_two_strip_differ_on_colour():
    img = _random_rgba(np.random.default_rng(4))
    params = {"fringe": 0.0, "amount": 1.0}
    assert not np.array_equal(
        technicolor(img, {**params, "process": "two_strip"}),
        technicolor(img, {**params, "process": "three_strip"}),
    )


def test_dye_density_one_cross_talk_zero_is_a_plain_print():
    img = _random_rgba(np.random.default_rng(5))
    out = technicolor(img, {**RECORDS_ONLY, "fringe": 0.0})
    np.testing.assert_array_equal(out, img)


def test_denser_dyes_darken_and_cross_talk_softens_colour():
    img = _solid((200, 90, 60))
    base = {"fringe": 0.0, "amount": 1.0, "cross_talk": 0.0}
    thin = technicolor(img, {**base, "dye_density": 0.6})
    dense = technicolor(img, {**base, "dye_density": 1.8})
    assert int(dense[0, 0, :3].sum()) < int(thin[0, 0, :3].sum())

    sharp = technicolor(img, {**base, "dye_density": 1.0})
    soft = technicolor(img, {**base, "dye_density": 1.0, "cross_talk": 1.0})
    spread = lambda o: int(o[0, 0, :3].max()) - int(o[0, 0, :3].min())
    assert spread(soft) < spread(sharp)


def test_alpha_untouched():
    img = _random_rgba(np.random.default_rng(6))
    for process in ("two_strip", "three_strip"):
        out = technicolor(img, {"process": process, "fringe": 4.0, "seed": 2})
        np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_shape_dtype_and_input_not_mutated():
    img = _random_rgba(np.random.default_rng(7))
    before = img.copy()
    for process in ("two_strip", "three_strip"):
        out = technicolor(img, {"process": process, "fringe": 4.0, "seed": 5})
        assert out.shape == img.shape
        assert out.dtype == np.uint8
        assert out is not img
    np.testing.assert_array_equal(img, before)


def test_amount_zero_returns_a_copy():
    img = _random_rgba(np.random.default_rng(8))
    out = technicolor(img, {"amount": 0.0})
    out[0, 0, 0] ^= 0xFF
    assert out[0, 0, 0] != img[0, 0, 0]


def test_fringe_misaligns_the_records_at_an_edge():
    img = _step_edge(64)
    aligned = _edge_positions(technicolor(img, {**RECORDS_ONLY, "fringe": 0.0}))
    np.testing.assert_allclose(aligned, 32.0, atol=1e-9)
    fringed = _edge_positions(
        technicolor(img, {**RECORDS_ONLY, "fringe": 6.0, "seed": 3})
    )
    assert fringed.max() - fringed.min() > 1.0


def test_shift_record_is_bilinear_and_edge_clamped():
    plane = np.arange(5, dtype=np.float64)[None, :].repeat(3, axis=0)
    np.testing.assert_allclose(_shift_record(plane, 1.0, 0.0)[0], [0, 0, 1, 2, 3])
    np.testing.assert_allclose(
        _shift_record(plane, 0.5, 0.0)[0], [0, 0.5, 1.5, 2.5, 3.5]
    )
    np.testing.assert_allclose(_shift_record(plane, -1.0, 0.0)[0], [1, 2, 3, 4, 4])
    np.testing.assert_array_equal(_shift_record(plane, 0.0, 0.0), plane)


@pytest.mark.parametrize("seed", [3, 7, 21])
def test_fringe_scales_with_resolution_factor(seed):
    """`fringe` is `scale: "spatial"`: a DRAFT cook (1/8 res) arrives with it
    pre-divided by 8. The offsets are the seed's unit offsets times `fringe`,
    so the draft's shifts are exactly 1/8 of the full-resolution ones, i.e.
    the same fraction of the picture."""
    np.testing.assert_allclose(
        _record_offsets(seed, 6.0 / 8), _record_offsets(seed, 6.0) / 8
    )

    full = technicolor(_step_edge(64), {**RECORDS_ONLY, "fringe": 6.0, "seed": seed})
    draft = technicolor(
        _step_edge(8), {**RECORDS_ONLY, "fringe": 6.0 / 8, "seed": seed}
    )
    full_pos = _edge_positions(full)
    draft_pos = _edge_positions(draft)
    # Edge movement relative to the aligned position, as a fraction of width.
    full_move = (full_pos - 32.0) / 64.0
    draft_move = (draft_pos - 4.0) / 8.0
    assert np.abs(full_move).max() > 0.01  # the shift is real, not vacuous
    np.testing.assert_allclose(draft_move, full_move, atol=0.004)
