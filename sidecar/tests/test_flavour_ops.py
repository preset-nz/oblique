"""Unit tests for the 2026-07-04 flavour-ops batch: `colour_crush`,
`xerox`, `ink_starved`. Same conventions as `test_ops.py` — shape/dtype
preservation, alpha passthrough, seed determinism, edge-of-range params.
"""

from __future__ import annotations

import numpy as np
import pytest

from ops import LUMA_B709, LUMA_G709, LUMA_R709, OPS
from ops.cmyk_halftone import _screen_channel, _separate, cmyk_halftone
from ops.colour_crush import colour_crush
from ops.colourise import colourise
from ops.desaturate import desaturate
from ops.ink_starved import ink_starved
from ops.pixelate import pixelate
from ops.recolour import recolour
from ops.xerox import xerox

ALL_OPS = [
    (colour_crush, {"bits": 3, "dither": False}),
    (xerox, {"generations": 3, "skew": 0.3, "seed": 7}),
    (ink_starved, {"direction": "h", "starvation": 0.4, "banding": 0.2, "seed": 7}),
    (desaturate, {"amount": 0.6}),
    (pixelate, {"cell_size": 4}),
    (colourise, {"colour": "#7a5c3a", "amount": 0.6, "preserve_luma": True}),
    (
        recolour,
        {
            "stop_1": "#000000",
            "stop_2": "#4a3f6b",
            "stop_3": "#b06a4a",
            "stop_4": "#ffffff",
            "stops": 3,
            "blend": 0.8,
            "preserve_luma": False,
        },
    ),
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
    [
        "colour_crush",
        "xerox",
        "ink_starved",
        "desaturate",
        "pixelate",
        "colourise",
        "recolour",
    ],
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

    a = xerox(img, {"generations": 3, "seed": 1})
    b = xerox(img, {"generations": 3, "seed": 2})

    assert not np.array_equal(a, b)


def test_xerox_mono_by_default():
    rng = np.random.default_rng(10)
    img = _random_rgba(rng, h=20, w=20)

    out = xerox(img, {"generations": 2, "skew": 0.0, "seed": 3})

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


# --- desaturate -----------------------------------------------------------


def test_desaturate_amount_zero_is_identity():
    rng = np.random.default_rng(15)
    img = _random_rgba(rng)

    out = desaturate(img, {"amount": 0.0})

    np.testing.assert_array_equal(out, img)


def test_desaturate_amount_one_equalises_channels():
    rng = np.random.default_rng(16)
    img = _random_rgba(rng)

    out = desaturate(img, {"amount": 1.0})

    np.testing.assert_array_equal(out[..., 0], out[..., 1])
    np.testing.assert_array_equal(out[..., 1], out[..., 2])


# --- pixelate ---------------------------------------------------------------


def test_pixelate_cell_size_one_is_identity():
    rng = np.random.default_rng(17)
    img = _random_rgba(rng)

    out = pixelate(img, {"cell_size": 1})

    np.testing.assert_array_equal(out, img)


def test_pixelate_non_multiple_dimensions_preserve_shape():
    rng = np.random.default_rng(18)
    img = _random_rgba(rng, h=25, w=37)

    out = pixelate(img, {"cell_size": 6})

    assert out.shape == img.shape


def test_pixelate_interior_cell_is_flat():
    # Two-tone image: colour A on the left, colour B on the right, with the
    # boundary landing *mid-cell* (at column 20, cell_size 8) so the cell
    # spanning columns 16-23 straddles it and genuinely exercises the mean,
    # not just a cell that happened to already be uniform in the input.
    img = np.zeros((32, 32, 4), dtype=np.uint8)
    img[:, :20] = [200, 20, 20, 255]
    img[:, 20:] = [20, 20, 200, 255]

    out = pixelate(img, {"cell_size": 8})

    straddling = out[0:8, 16:24, :3]
    assert np.all(straddling == straddling[0, 0])
    # 4 px of A + 4 px of B, both fully opaque -> plain average.
    np.testing.assert_array_equal(straddling[0, 0], [110, 20, 110])


def test_pixelate_clean_blocks_no_seam_at_edges():
    rng = np.random.default_rng(19)
    img = _random_rgba(rng, h=48, w=64)
    img[..., 3] = 255  # opaque, so alpha's per-pixel randomness can't mask
    # the RGB block-flatness check below.

    out = pixelate(img, {"cell_size": 16})

    # Every 16x16 block's colour is flat: no seam or half-cell artefact
    # anywhere, including the right/bottom edges (dims are exact multiples).
    for y in range(0, 48, 16):
        for x in range(0, 64, 16):
            block = out[y : y + 16, x : x + 16, :3]
            assert np.all(block == block[0, 0])


def test_pixelate_edge_padding_replicates_not_zero_fills():
    # Solid opaque white, dims not a multiple of cell_size: edge-replicated
    # padding keeps every cell (including the partial right/bottom ones) at
    # a mean of exactly 255 -> the whole output is unchanged. Zero/black
    # padding would drag the partial edge cells below 255 and fail this
    # immediately -- this is the discriminating check for the "average only
    # the real pixels, pad with mode='edge'" requirement.
    img = np.full((20, 20, 4), 255, dtype=np.uint8)

    out = pixelate(img, {"cell_size": 8})

    np.testing.assert_array_equal(out, img)


# --- colourise --------------------------------------------------------------


def test_colourise_amount_zero_is_identity():
    rng = np.random.default_rng(20)
    img = _random_rgba(rng)

    out = colourise(img, {"colour": "#7a5c3a", "amount": 0.0})

    np.testing.assert_array_equal(out, img)


def test_colourise_preserve_luma_matches_source_luma_on_mid_grey():
    img = np.full((16, 16, 4), 128, dtype=np.uint8)
    img[..., 3] = 255

    out = colourise(
        img,
        {"colour": "#7a5c3a", "amount": 1.0, "preserve_luma": True},
    )

    out_rgb = out[..., :3].astype(np.float64)
    out_luma = (
        out_rgb[..., 0] * LUMA_R709
        + out_rgb[..., 1] * LUMA_G709
        + out_rgb[..., 2] * LUMA_B709
    )
    src_luma = 128 * LUMA_R709 + 128 * LUMA_G709 + 128 * LUMA_B709

    np.testing.assert_allclose(out_luma, src_luma, atol=1.5)


def test_colourise_garbage_colour_falls_back_to_default():
    rng = np.random.default_rng(21)
    img = _random_rgba(rng, h=20, w=20)

    default_out = colourise(img, {"colour": "#7a5c3a", "amount": 1.0})
    garbage_out = colourise(img, {"colour": "puce", "amount": 1.0})

    np.testing.assert_array_equal(garbage_out, default_out)


# --- recolour -----------------------------------------------------------


def test_recolour_blend_zero_is_identity():
    rng = np.random.default_rng(22)
    img = _random_rgba(rng)

    out = recolour(img, {"blend": 0.0})

    np.testing.assert_array_equal(out, img)


def test_recolour_two_stop_black_white_approximates_greyscale():
    rng = np.random.default_rng(23)
    img = _random_rgba(rng, h=24, w=24)
    img[..., 3] = 255

    out = recolour(
        img,
        {
            "stop_1": "#000000",
            "stop_2": "#ffffff",
            "stops": 2,
            "blend": 1.0,
            "preserve_luma": False,
        },
    )

    rgb = img[..., :3].astype(np.float64)
    expected_luma = (
        rgb[..., 0] * LUMA_R709 + rgb[..., 1] * LUMA_G709 + rgb[..., 2] * LUMA_B709
    )

    out_rgb = out[..., :3].astype(np.float64)
    np.testing.assert_allclose(out_rgb[..., 0], expected_luma, atol=1.5)
    np.testing.assert_allclose(out_rgb[..., 1], expected_luma, atol=1.5)
    np.testing.assert_allclose(out_rgb[..., 2], expected_luma, atol=1.5)


def test_recolour_garbage_stop_colour_falls_back_to_default():
    rng = np.random.default_rng(24)
    img = _random_rgba(rng, h=20, w=20)

    default_out = recolour(img, {"stop_2": "#4a3f6b"})
    garbage_out = recolour(img, {"stop_2": "puce"})

    np.testing.assert_array_equal(garbage_out, default_out)


# --- cmyk_halftone (ink remap, 2026-08-07) ---------------------------------
#
# `cmyk_halftone` shipped long before the `color` param kind existed and is
# in daily use, so this batch is the regression: at default ink colours the
# op must still produce exactly what the pre-remap `_ABSORB`-table
# implementation produced. See `sidecar/ops/cmyk_halftone.py` and
# `guidance/projects/oblique/features/15-colour/cmyk-ink-remap.md`.

# The literal table this story replaced. Frozen here, independent of the
# module's `_DEFAULT_INKS`, so this regression can't accidentally pass just
# because both sides drifted together.
_OLD_ABSORB = {
    "c": np.array([1.0, 0.0, 0.0]),  # cyan absorbs red
    "m": np.array([0.0, 1.0, 0.0]),  # magenta absorbs green
    "y": np.array([0.0, 0.0, 1.0]),  # yellow absorbs blue
    "k": np.array([1.0, 1.0, 1.0]),  # black absorbs everything
}
_OLD_ANGLES = {"angle_c": 15.0, "angle_m": 75.0, "angle_y": 0.0, "angle_k": 45.0}


def _pre_remap_cmyk_halftone(img: np.ndarray, params: dict) -> np.ndarray:
    """The op exactly as it stood before this story, reimplemented against
    the frozen `_OLD_ABSORB` table. Reuses the module's own (unchanged)
    `_separate`/`_screen_channel` helpers -- only the ink-absorption lookup
    is inlined here -- so this isolates the one thing the story changed and
    serves as the regression oracle for default-ink output."""
    pitch = max(1.0, float(params.get("dot_size", 6.0)))
    misreg = float(params.get("misregistration", 0.0))
    seed = int(params.get("seed", 0))
    mode = str(params.get("mode", "paper"))

    rgb = img[..., :3].astype(np.float64) / 255.0
    plates = _separate(rgb)

    rng = np.random.default_rng(seed)
    base = rgb if mode == "over" else np.ones_like(rgb)

    out_rgb = base.copy()
    for channel in ("c", "m", "y", "k"):
        angle = float(params.get(f"angle_{channel}", _OLD_ANGLES[f"angle_{channel}"]))
        jitter = rng.uniform(-1.0, 1.0, size=2) * misreg
        ink = _screen_channel(plates[channel], pitch, angle, (jitter[0], jitter[1]))
        out_rgb *= 1.0 - ink[..., None] * _OLD_ABSORB[channel]

    out = img.copy()
    out[..., :3] = np.clip(out_rgb * 255.0, 0.0, 255.0).astype(np.uint8)
    return out


@pytest.mark.parametrize("seed", [0, 42])
def test_cmyk_halftone_default_inks_are_byte_identical_to_pre_remap_op(seed):
    rng = np.random.default_rng(seed + 500)
    img = _random_rgba(rng, h=28, w=28)
    # Non-trivial misregistration, per the acceptance criterion, so the
    # per-channel jitter path is exercised too, not just the zero-jitter case.
    params = {"dot_size": 5.0, "misregistration": 3.0, "seed": seed}

    actual = cmyk_halftone(img, params)
    expected = _pre_remap_cmyk_halftone(img, params)

    np.testing.assert_array_equal(actual, expected)


def test_cmyk_halftone_missing_ink_params_fall_back_to_process_defaults():
    """A `.oblique` saved before this story has no `ink_*` keys at all --
    the fallback path must reconstruct the process-ink look exactly."""
    rng = np.random.default_rng(34)
    img = _random_rgba(rng, h=24, w=24)
    params = {"dot_size": 5.0, "misregistration": 2.0, "seed": 3}

    without_ink_params = cmyk_halftone(img, params)
    with_explicit_process_inks = cmyk_halftone(
        img,
        {
            **params,
            "ink_c": "#00ffff",
            "ink_m": "#ff00ff",
            "ink_y": "#ffff00",
            "ink_k": "#000000",
        },
    )

    np.testing.assert_array_equal(without_ink_params, with_explicit_process_inks)


def test_cmyk_halftone_ink_remap_changes_colour_not_dot_footprint():
    rng = np.random.default_rng(35)
    img = _random_rgba(rng, h=40, w=40)
    img[..., 3] = 255
    params = {"dot_size": 5.0, "misregistration": 1.5, "seed": 4}

    default_out = cmyk_halftone(img, params)
    remapped = cmyk_halftone(img, {**params, "ink_c": "#b03030", "ink_m": "#2f6b2f"})

    # Dot footprint: exactly-untouched-paper pixels (all three channels
    # still 255) come only from a zero coverage mask, which never depends
    # on ink colour -- so the *set* of such pixels must match exactly, not
    # just approximately. (Verified empirically across 20 seed/param
    # combinations before pinning this to equality rather than a tolerance:
    # zero mismatches every time, because a nonzero coverage always moves
    # at least one channel measurably off 255 regardless of which RGB
    # component the chosen ink's absorption vector lands on.)
    default_is_paper = np.all(default_out[..., :3] == 255, axis=-1)
    remapped_is_paper = np.all(remapped[..., :3] == 255, axis=-1)
    np.testing.assert_array_equal(default_is_paper, remapped_is_paper)

    assert not np.array_equal(default_out[..., :3], remapped[..., :3])


def test_cmyk_halftone_garbage_ink_falls_back_to_process_default():
    rng = np.random.default_rng(36)
    img = _random_rgba(rng, h=20, w=20)
    params = {"dot_size": 4.0, "seed": 5}

    default_out = cmyk_halftone(img, params)
    garbage_out = cmyk_halftone(
        img, {**params, "ink_c": "puce", "ink_k": "not-a-colour"}
    )

    np.testing.assert_array_equal(garbage_out, default_out)
