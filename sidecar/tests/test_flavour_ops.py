"""Unit tests for the 2026-07-04 flavour-ops batch: `colour_crush`,
`xerox`, `ink_starved`. Same conventions as `test_ops.py` — shape/dtype
preservation, alpha passthrough, seed determinism, edge-of-range params.
"""

from __future__ import annotations

import numpy as np
import pytest

from ops import LUMA_B709, LUMA_G709, LUMA_R709, OPS
from ops.bloom import bloom
from ops.cmyk_halftone import _screen_channel, _separate, cmyk_halftone
from ops.colour_crush import colour_crush
from ops.colourise import colourise
from ops.desaturate import desaturate
from ops.dilate import dilate
from ops.edge_noise import edge_noise
from ops.erode import erode
from ops.film_burn import _smoothstep, film_burn
from ops.hatch import hatch
from ops.ink_starved import ink_starved
from ops.pixelate import pixelate
from ops.recolour import recolour
from ops.smear import smear
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
    (dilate, {"radius": 3.0}),
    (erode, {"radius": 3.0}),
    (edge_noise, {"amount": 0.4, "scale": 12.0, "seed": 7}),
    (hatch, {"pattern": "dashes", "layers": 3, "spacing": 5.0, "seed": 7}),
    (smear, {"direction": "h", "mode": "forward", "position": 0.5}),
    (bloom, {"threshold": 0.7, "radius": 4.0, "intensity": 0.8, "blend": "screen"}),
    (
        film_burn,
        {
            "progress": 0.5,
            "count": 2,
            "irregularity": 0.4,
            "scale": 16.0,
            "bubble": 0.5,
            "char": 0.4,
            "char_colour": "#2a1608",
            "hole": "white",
            "seed": 7,
        },
    ),
]

# `test_alpha_untouched` is the only battery test that doesn't apply to
# every op — an op declaring `writes_alpha=True` is exempt from it, and
# stays covered by the other three. Derived from the registry, not a
# hand-maintained list, so a future alpha-writing op can't be forgotten.
ALPHA_PRESERVING_OPS = [
    (fn, params) for (fn, params) in ALL_OPS if not OPS[fn.__name__].writes_alpha
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


@pytest.mark.parametrize("fn,params", ALPHA_PRESERVING_OPS)
def test_alpha_untouched(fn, params):
    rng = np.random.default_rng(2)
    img = _random_rgba(rng)

    out = fn(img, params)

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_alpha_preserving_ops_declare_it():
    for fn, _ in ALPHA_PRESERVING_OPS:
        assert OPS[fn.__name__].writes_alpha is False


def test_all_ops_are_split_between_the_two_suites():
    alpha_writing = {fn.__name__ for fn, _ in ALL_OPS} - {
        fn.__name__ for fn, _ in ALPHA_PRESERVING_OPS
    }
    for fn, _ in ALL_OPS:
        if fn.__name__ in alpha_writing:
            assert OPS[fn.__name__].writes_alpha is True
        else:
            assert OPS[fn.__name__].writes_alpha is False


@pytest.mark.parametrize("name", sorted(OPS))
def test_registry_entry_runs_the_op_it_names(name):
    """Every registered op's `fn` is the function it is named after, and
    runs through the registry the way `handlers/cook.py` calls it. Guards a
    decorator ending up on the wrong function: on 2026-09-17 helpers were
    inserted between `@op("hatch", ...)` and `def hatch`, so the registry
    wrapped `_coverage_numpy`. Every test called `hatch()` by name and
    passed; the app's first cook failed."""
    entry = OPS[name]
    assert entry.fn.__name__ == name
    img = np.random.default_rng(0).integers(0, 256, (24, 31, 4), dtype=np.uint8)
    out = entry.fn(img, {})
    assert out.shape == img.shape
    assert out.dtype == np.uint8


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
        "hatch",
        "smear",
        "bloom",
        "film_burn",
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


@pytest.mark.parametrize("seed,pitch", [(0, 4.0), (11, 8.0), (22, 3.0)])
def test_cmyk_halftone_white_is_alpha_false_is_byte_identical(seed, pitch):
    """Explicit `white_is_alpha=False` must match the flag being absent --
    the byte-identical regression this story is not allowed to break."""
    rng = np.random.default_rng(seed + 900)
    img = _random_rgba(rng, h=24, w=24)
    params = {"dot_size": pitch, "misregistration": 1.0, "seed": seed}

    without_flag = cmyk_halftone(img, params)
    with_flag_false = cmyk_halftone(img, {**params, "white_is_alpha": False})

    np.testing.assert_array_equal(without_flag, with_flag_false)


def test_cmyk_halftone_white_is_alpha_composites_equal_to_flag_off_over_white():
    """The acceptance criterion that catches a missing un-blend: with an
    opaque input, `white_is_alpha=True` composited (straight src-over) over
    an opaque white backdrop must reproduce the `white_is_alpha=False`
    result within a small tolerance."""
    rng = np.random.default_rng(50)
    img = _random_rgba(rng, h=32, w=32)
    img[..., 3] = 255
    params = {"dot_size": 5.0, "misregistration": 1.5, "seed": 8}

    opaque_out = cmyk_halftone(img, params)
    alpha_out = cmyk_halftone(img, {**params, "white_is_alpha": True})

    alpha = alpha_out[..., 3].astype(np.float64) / 255.0
    composited = alpha_out[..., :3].astype(np.float64) * alpha[..., None] + 255.0 * (
        1.0 - alpha[..., None]
    )

    np.testing.assert_allclose(
        composited, opaque_out[..., :3].astype(np.float64), atol=2.0
    )


def test_cmyk_halftone_white_is_alpha_paper_is_transparent():
    # Pure white input -> zero ink coverage almost everywhere -> alpha 0.
    # `_screen_channel`'s 1px AA smoothstep gives a handful of pixels near
    # exact grid-origin alignment a sliver of ink even at zero coverage
    # (pre-existing behaviour of the unchanged screening math, not
    # something this story introduces or fixes) -- so this asserts the
    # overwhelming majority, not literally every pixel.
    img = np.full((32, 32, 4), 255, dtype=np.uint8)

    out = cmyk_halftone(img, {"dot_size": 4.0, "white_is_alpha": True})

    assert (out[..., 3] == 0).mean() > 0.75


def test_cmyk_halftone_white_is_alpha_solid_ink_matches_input_alpha():
    # Pure black input -> near-full ink coverage everywhere -> alpha close
    # to the input's own alpha. The screen's circle-packing overdrive
    # doesn't perfectly close every cell seam (same pre-existing quirk as
    # above), so a few pixels land slightly under full coverage.
    img = np.zeros((32, 32, 4), dtype=np.uint8)
    img[..., 3] = 200

    out = cmyk_halftone(img, {"dot_size": 4.0, "white_is_alpha": True})

    assert (out[..., 3] == 200).mean() > 0.7
    assert (out[..., 3] <= 200).all()


def test_cmyk_halftone_white_is_alpha_never_exceeds_input_alpha():
    rng = np.random.default_rng(51)
    img = _random_rgba(rng, h=28, w=28)
    img[..., 3] = 120

    out = cmyk_halftone(img, {"dot_size": 5.0, "white_is_alpha": True})

    assert (out[..., 3] <= 120).all()


@pytest.mark.parametrize(
    "img_factory",
    [
        lambda: np.zeros((12, 12, 4), dtype=np.uint8),
        lambda: np.full((12, 12, 4), 255, dtype=np.uint8),
    ],
)
def test_cmyk_halftone_white_is_alpha_no_nan_no_inf_no_wraparound(img_factory):
    img = img_factory()
    img[..., 3] = 255

    out = cmyk_halftone(img, {"dot_size": 4.0, "white_is_alpha": True})

    assert out.dtype == np.uint8
    assert np.isfinite(out).all()
    assert (out >= 0).all() and (out <= 255).all()


def test_cmyk_halftone_white_is_alpha_ignored_in_over_mode():
    rng = np.random.default_rng(52)
    img = _random_rgba(rng, h=20, w=20)
    params = {"dot_size": 4.0, "mode": "over"}

    flag_off = cmyk_halftone(img, params)
    flag_on = cmyk_halftone(img, {**params, "white_is_alpha": True})

    np.testing.assert_array_equal(flag_off, flag_on)
    np.testing.assert_array_equal(flag_on[..., 3], img[..., 3])


def test_cmyk_halftone_declares_writes_alpha():
    assert OPS["cmyk_halftone"].writes_alpha is True


# --- smear (2026-09-18) -----------------------------------------------------


def _striped_h(h: int = 8, w: int = 10) -> np.ndarray:
    """Each column x carries a distinct red value x*10, fully opaque —
    lets a test read off exactly which column ended up where."""
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., 0] = np.arange(w) * 10
    img[..., 3] = 255
    return img


def _striped_v(h: int = 10, w: int = 8) -> np.ndarray:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., 0] = np.arange(h)[:, None] * 10
    img[..., 3] = 255
    return img


def test_smear_declares_writes_alpha():
    assert OPS["smear"].writes_alpha is True


def test_smear_forward_writes_from_line_onward_leaves_before_untouched():
    img = _striped_h()
    idx = 4  # position 0.5 over axis_len 10 -> round(0.5*9) = 4 (banker's round -> 4)

    out = smear(img, {"direction": "h", "mode": "forward", "position": 0.5})

    line = img[:, idx, :]
    np.testing.assert_array_equal(
        out[:, idx:, :], np.broadcast_to(line[:, None, :], out[:, idx:, :].shape)
    )
    np.testing.assert_array_equal(out[:, :idx, :], img[:, :idx, :])


def test_smear_backward_writes_up_to_line_leaves_after_untouched():
    img = _striped_h()
    idx = 4

    out = smear(img, {"direction": "h", "mode": "backward", "position": 0.5})

    line = img[:, idx, :]
    np.testing.assert_array_equal(
        out[:, : idx + 1, :],
        np.broadcast_to(line[:, None, :], out[:, : idx + 1, :].shape),
    )
    np.testing.assert_array_equal(out[:, idx + 1 :, :], img[:, idx + 1 :, :])


def test_smear_both_replaces_the_entire_frame():
    img = _striped_h()
    idx = 4

    out = smear(img, {"direction": "h", "mode": "both", "position": 0.5})

    line = img[:, idx, :]
    np.testing.assert_array_equal(out, np.broadcast_to(line[:, None, :], out.shape))


def test_smear_direction_h_samples_a_column():
    img = _striped_h()

    out = smear(img, {"direction": "h", "mode": "both", "position": 0.0})

    assert np.all(out[..., 0] == img[0, 0, 0])


def test_smear_direction_v_samples_a_row():
    img = _striped_v()

    out = smear(img, {"direction": "v", "mode": "both", "position": 1.0})

    assert np.all(out[..., 0] == img[-1, 0, 0])


def test_smear_position_zero_hits_first_line_no_index_error():
    img = _striped_h()

    out = smear(img, {"direction": "h", "mode": "both", "position": 0.0})

    assert np.all(out[..., 0] == img[0, 0, 0])


def test_smear_position_one_hits_last_line_no_index_error():
    img = _striped_h()

    out = smear(img, {"direction": "h", "mode": "both", "position": 1.0})

    assert np.all(out[..., 0] == img[0, -1, 0])


def test_smear_clip_to_alpha_writes_nothing_where_source_alpha_was_zero():
    img = _striped_h()
    img[:, :5, 3] = 0  # left half transparent, right half opaque

    # Sample the last column (opaque), so the only thing keeping the left
    # half untouched is the destination-side half of the gate.
    out = smear(
        img, {"direction": "h", "mode": "both", "position": 1.0, "clip_to_alpha": True}
    )

    # Untouched where the source had no alpha: byte-identical to input,
    # colour included.
    np.testing.assert_array_equal(out[:, :5, :], img[:, :5, :])
    # Alpha itself is never touched by clip_to_alpha, even where it wrote.
    np.testing.assert_array_equal(out[:, 5:, 3], img[:, 5:, 3])
    # But colour *did* get overwritten with the sampled line where alpha
    # was > 0.
    assert np.all(out[:, 5:, 0] == img[0, -1, 0])


def test_smear_clip_to_alpha_skips_a_transparent_sample_pixel():
    """The other half of the two-sided gate: RGB behind zero alpha is
    undefined, so a transparent sampled pixel must not paint a band into
    an opaque destination."""
    img = _striped_h()
    img[:, :5, 3] = 0  # left half transparent, right half opaque

    # Sample column 0 — inside the transparent half, so it carries no
    # meaningful colour even though the right half is a valid destination.
    out = smear(
        img, {"direction": "h", "mode": "both", "position": 0.0, "clip_to_alpha": True}
    )

    np.testing.assert_array_equal(out, img)


def test_smear_clip_to_alpha_false_writes_sampled_alpha_everywhere_in_region():
    img = _striped_h()
    img[:, :, 3] = 0  # fully transparent source

    out = smear(
        img,
        {"direction": "h", "mode": "both", "position": 3 / 9, "clip_to_alpha": False},
    )

    # The sampled column's alpha (0, since the whole source is transparent)
    # travels with its colour everywhere the smear writes.
    np.testing.assert_array_equal(out[..., 3], np.zeros_like(out[..., 3]))


def test_smear_alpha_travels_with_colour_into_transparent_territory():
    # This is the headline `writes_alpha=True` contract, and the exact
    # pathology `pixelate.py` warns about if it silently regressed: the
    # sampled line's alpha must extend the silhouette, not just its
    # colour. Left half starts transparent; sampling an opaque column and
    # smearing it "both" must make the whole frame opaque.
    img = _striped_h()
    img[:, :5, 3] = 0

    out = smear(img, {"direction": "h", "mode": "both", "position": 1.0})

    assert np.all(out[..., 3] == 255)


def test_smear_alpha_travels_with_colour_erasing_into_source():
    # Mirror: sampling a transparent column and smearing it over an
    # opaque source must erase alpha where it writes, not just leave the
    # opaque colour with stale full alpha behind it.
    img = _striped_h()
    img[:, :5, 3] = 0  # column 0 (the sample at position 0.0) is transparent

    out = smear(img, {"direction": "h", "mode": "both", "position": 0.0})

    assert np.all(out[..., 3] == 0)


def test_smear_direction_v_forward_region_is_not_transposed():
    # Every other region-correctness test above uses `direction="h"`;
    # `mode="both"` (used by the v-direction smoke tests) covers the whole
    # frame regardless of axis, so it can't catch a transposed region
    # tuple in the `v` branch. This uses `forward` at a mid-position,
    # where only the correct (row-sliced, full-width) region passes.
    img = _striped_v()
    idx = 4  # position 0.5 over axis_len 10 -> round(0.5 * 9) = 4

    out = smear(img, {"direction": "v", "mode": "forward", "position": 0.5})

    row = img[idx, :, :]
    np.testing.assert_array_equal(
        out[idx:, :, :], np.broadcast_to(row[None, :, :], out[idx:, :, :].shape)
    )
    np.testing.assert_array_equal(out[:idx, :, :], img[:idx, :, :])


def test_smear_fully_transparent_input_does_not_crash():
    img = np.zeros((6, 8, 4), dtype=np.uint8)

    for direction in ("h", "v"):
        for mode in ("forward", "both", "backward"):
            out = smear(
                img,
                {
                    "direction": direction,
                    "mode": mode,
                    "position": 0.5,
                    "clip_to_alpha": True,
                },
            )
            assert out.shape == img.shape
            assert out.dtype == np.uint8

            out2 = smear(
                img,
                {
                    "direction": direction,
                    "mode": mode,
                    "position": 0.5,
                    "clip_to_alpha": False,
                },
            )
            assert out2.shape == img.shape
            assert out2.dtype == np.uint8


# --- bloom (2026-09-18) ------------------------------------------------


def test_bloom_declares_writes_alpha():
    assert OPS["bloom"].writes_alpha is True


@pytest.mark.parametrize("blend", ["screen", "add"])
@pytest.mark.parametrize(
    "params",
    [
        {"threshold": 0.7, "radius": 4.0, "intensity": 0.8},
        {"threshold": 0.3, "radius": 24.0, "intensity": 2.0},
        {"threshold": 0.95, "radius": 1.0, "intensity": 0.01},
    ],
)
def test_bloom_spill_false_alpha_byte_identical(blend, params):
    # Replaces exactly the `ALPHA_PRESERVING_OPS` battery coverage that
    # declaring `writes_alpha=True` forfeits — the single most important
    # test in this op, per a random-alpha image (not just 0/255), swept
    # across both blend modes and a spread of thresholds/radii/intensities.
    rng = np.random.default_rng(11)
    img = _random_rgba(rng, h=20, w=28)

    out = bloom(img, {**params, "blend": blend, "spill": False})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_bloom_below_threshold_is_unchanged():
    img = np.full((12, 12, 4), 128, dtype=np.uint8)
    img[..., 3] = 255

    out = bloom(img, {"threshold": 0.7, "radius": 4.0, "intensity": 0.8})

    np.testing.assert_array_equal(out, img)


def test_bloom_single_bright_pixel_spreads_light_to_neighbours():
    img = np.zeros((16, 16, 4), dtype=np.uint8)
    img[..., 3] = 255
    img[8, 8, :3] = 255

    out = bloom(
        img, {"threshold": 0.7, "radius": 2.0, "intensity": 0.8, "blend": "screen"}
    )

    assert out[8, 7, 0] > 0
    assert out[7, 8, 0] > 0


def test_bloom_intensity_zero_is_exact_noop():
    rng = np.random.default_rng(3)
    img = _random_rgba(rng)

    out = bloom(img, {"threshold": 0.5, "radius": 8.0, "intensity": 0.0})

    np.testing.assert_array_equal(out, img)


def test_bloom_radius_zero_is_exact_noop():
    rng = np.random.default_rng(4)
    img = _random_rgba(rng)

    out = bloom(img, {"threshold": 0.5, "radius": 0.0, "intensity": 0.8})

    np.testing.assert_array_equal(out, img)


def test_bloom_screen_never_exceeds_255_and_never_darkens():
    rng = np.random.default_rng(5)
    img = _random_rgba(rng, h=20, w=20)
    img[..., 3] = 255  # fully opaque, so the whole frame is "in silhouette"

    out = bloom(
        img, {"threshold": 0.4, "radius": 6.0, "intensity": 1.5, "blend": "screen"}
    )

    assert np.all(out[..., :3] <= 255)
    assert np.all(out[..., :3].astype(np.int16) >= img[..., :3].astype(np.int16))


def test_bloom_add_clips_rather_than_wraps():
    img = np.full((10, 10, 4), 250, dtype=np.uint8)
    img[..., 3] = 255

    out = bloom(
        img, {"threshold": 0.7, "radius": 4.0, "intensity": 2.0, "blend": "add"}
    )

    # If this wrapped modulo 256 instead of clipping, a near-white input
    # blown out hard would come back as a low value, not stay at 255.
    assert np.all(out[..., :3] == 255)


def test_bloom_spill_true_fully_opaque_image_leaves_alpha_at_255():
    rng = np.random.default_rng(6)
    img = _random_rgba(rng, h=16, w=16)
    img[..., 3] = 255

    out = bloom(img, {"threshold": 0.3, "radius": 6.0, "intensity": 1.2, "spill": True})

    np.testing.assert_array_equal(out[..., 3], np.full((16, 16), 255, dtype=np.uint8))


def test_bloom_spill_true_writes_alpha_outside_silhouette_spill_false_does_not():
    # Left half bright and opaque, right half fully transparent — a wide
    # enough radius pushes the blurred glow into the transparent half.
    img = np.zeros((32, 32, 4), dtype=np.uint8)
    img[:, :16, :3] = 255
    img[:, :16, 3] = 255

    params = {"threshold": 0.7, "radius": 4.0, "intensity": 0.8, "spill": True}
    out_spill = bloom(img, params)
    out_no_spill = bloom(img, {**params, "spill": False})

    # A few px into the transparent half, spill has written alpha...
    assert out_spill[16, 18, 3] > 0
    # ...while spill=False left that region byte-identical to the input.
    np.testing.assert_array_equal(out_no_spill[:, 16:, :], img[:, 16:, :])


# --- film_burn (2026-09-18) ---------------------------------------------


def test_film_burn_declares_writes_alpha():
    assert OPS["film_burn"].writes_alpha is True


def test_film_burn_progress_zero_is_exact_noop():
    rng = np.random.default_rng(20)
    img = _random_rgba(rng, h=24, w=24)

    out = film_burn(img, {"progress": 0.0, "seed": 3})

    np.testing.assert_array_equal(out, img)


@pytest.mark.parametrize("count", [1, 2, 4])
def test_film_burn_progress_one_consumes_the_entire_frame(count):
    # irregularity=0 removes the noise term, so REACH's worst-case margin
    # (see the module docstring) holds with float-exact equality: every
    # pixel clears the burn-through band's far edge regardless of hot-spot
    # placement or count.
    img = np.full((20, 28, 4), 128, dtype=np.uint8)
    img[..., 3] = 255

    out = film_burn(
        img,
        {
            "progress": 1.0,
            "count": count,
            "irregularity": 0.0,
            "char": 0.4,
            "hole": "transparent",
            "seed": 5,
        },
    )

    # Every pixel is fully in burn-through: RGB blown white, alpha at 0.
    np.testing.assert_array_equal(
        out[..., :3], np.full((20, 28, 3), 255, dtype=np.uint8)
    )
    np.testing.assert_array_equal(out[..., 3], np.zeros((20, 28), dtype=np.uint8))


@pytest.mark.parametrize(
    "params",
    [
        {"progress": 0.5, "bubble": 0.0, "count": 1, "seed": 4},
        {"progress": 0.9, "bubble": 0.0, "count": 3, "irregularity": 0.8, "seed": 9},
        {"progress": 0.2, "bubble": 0.0, "count": 2, "char": 0.1, "seed": 1},
    ],
)
def test_film_burn_hole_white_bubble_zero_alpha_byte_identical(params):
    # Replaces exactly the `ALPHA_PRESERVING_OPS` battery coverage that
    # declaring `writes_alpha=True` forfeits. `bubble=0` excludes the
    # warp, which legitimately moves alpha under `hole="white"` too.
    rng = np.random.default_rng(21)
    img = _random_rgba(rng, h=20, w=20)

    out = film_burn(img, {**params, "hole": "white"})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_film_burn_hole_transparent_drives_alpha_to_zero_in_the_burnt_core():
    img = np.full((24, 24, 4), 200, dtype=np.uint8)
    img[..., 3] = 255

    out = film_burn(
        img,
        {
            "progress": 1.0,
            "count": 1,
            "irregularity": 0.0,
            "hole": "transparent",
            "seed": 2,
        },
    )

    np.testing.assert_array_equal(out[..., 3], np.zeros((24, 24), dtype=np.uint8))


def test_film_burn_blister_warp_moves_content_away_from_the_hot_spot():
    # Pin the warp's sign: the required visual is "content moves away from
    # the hot spot, as a blister stretches what's sitting on it" — checked
    # via the intensity-weighted centroid of a small bright marker placed a
    # known distance from the (seed-determined) single hot spot.
    from ops.film_burn import _REACH_EPS

    seed = 11
    h = w = 80
    rng = np.random.default_rng(seed)
    spot = rng.uniform(0.0, 1.0, size=(1, 2))
    hot_y = spot[0, 0] * (h - 1)
    hot_x = spot[0, 1] * (w - 1)

    marker_y = int(np.clip(round(hot_y), 12, h - 13))
    marker_x = int(np.clip(round(hot_x) + 25, 12, w - 13))

    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., 3] = 255
    img[marker_y - 1 : marker_y + 2, marker_x - 1 : marker_x + 2, :3] = 255

    # A same-field, marker-free background run. Both blister zones (the
    # only zone that warps) *and* the blister/scorch recolour of a black
    # background are entirely position-driven, not content-driven, so
    # they are identical between the two runs everywhere the marker's own
    # warped footprint doesn't reach — subtracting them isolates exactly
    # where the marker's content ended up, with no recolour-of-the-
    # background confound on the centroid.
    bg = np.zeros((h, w, 4), dtype=np.uint8)
    bg[..., 3] = 255

    char = 0.4
    irregularity = 0.0
    char_w = max(1e-3, char * 0.25)
    diagonal = float(np.hypot(h, w))
    dist = float(np.hypot(marker_y - hot_y, marker_x - hot_x))
    d01 = dist / diagonal
    target_burn = char_w * 0.5  # mid-blister-band, well clear of scorch
    reach = 1.0 + 3.0 * char_w + 0.5 * irregularity + _REACH_EPS
    progress = float(np.clip((target_burn + d01) / reach, 0.01, 0.99))

    params = {
        "progress": progress,
        "count": 1,
        "irregularity": irregularity,
        "scale": 24.0,
        "bubble": 1.0,
        "char": char,
        "char_colour": "#2a1608",
        "hole": "white",
        "seed": seed,
    }
    out_marker = film_burn(img, params)
    out_bg = film_burn(bg, params)

    diff = out_marker[..., :3].astype(np.float64) - out_bg[..., :3].astype(np.float64)
    weight = np.clip(diff, 0.0, None).sum(axis=-1)
    assert weight.sum() > 0.0, "expected the marker's warped footprint to be visible"

    ys, xs = np.mgrid[0:h, 0:w]
    total = float(weight.sum())
    centroid_y = float((ys * weight).sum() / total)
    centroid_x = float((xs * weight).sum() / total)
    after = float(np.hypot(centroid_y - hot_y, centroid_x - hot_x))

    assert after > dist


def test_film_burn_same_seed_identical_different_seed_differs():
    rng = np.random.default_rng(22)
    img = _random_rgba(rng, h=24, w=24)
    params = {"progress": 0.5, "count": 2, "seed": 7}

    out1 = film_burn(img, params)
    out2 = film_burn(img, params)
    out_diff_seed = film_burn(img, {**params, "seed": 99})

    np.testing.assert_array_equal(out1, out2)
    assert not np.array_equal(out1, out_diff_seed)


def test_film_burn_count_four_burns_more_area_than_count_one_at_equal_progress():
    img = np.full((40, 40, 4), 150, dtype=np.uint8)
    img[..., 3] = 255

    params = {"progress": 0.3, "irregularity": 0.4, "bubble": 0.0, "seed": 6}
    out_one = film_burn(img, {**params, "count": 1})
    out_four = film_burn(img, {**params, "count": 4})

    diff_one = np.abs(out_one.astype(np.int16) - img.astype(np.int16)).sum()
    diff_four = np.abs(out_four.astype(np.int16) - img.astype(np.int16)).sum()
    assert diff_four > diff_one


def test_film_burn_char_colour_appears_in_the_scorch_band():
    # irregularity=0 and bubble=0 keep the annulus clean (no noise wobble,
    # no warp) so the scorch ring is exactly the pixels between char_w and
    # 2*char_w in field units.
    from ops.film_burn import _REACH_EPS

    h = w = 80
    seed = 3
    img = np.full((h, w, 4), 200, dtype=np.uint8)
    img[..., 3] = 255

    char = 0.4
    char_w = max(1e-3, char * 0.25)
    reach = 1.0 + 3.0 * char_w + 0.5 * 0.0 + _REACH_EPS
    # progress that lands the field's median burn value in the middle of
    # the scorch band for a single, centred-ish hot spot at this seed.
    progress = float((1.5 * char_w) / reach) + 0.05

    char_colour = "#2a1608"
    out = film_burn(
        img,
        {
            "progress": progress,
            "count": 1,
            "irregularity": 0.0,
            "bubble": 0.0,
            "char": char,
            "char_colour": char_colour,
            "hole": "white",
            "seed": seed,
        },
    )

    target = np.array([0x2A, 0x16, 0x08], dtype=np.float64)
    orig_dist = float(np.linalg.norm(img[0, 0, :3].astype(np.float64) - target))

    changed = np.any(out[..., :3] != img[..., :3], axis=-1) & np.any(
        out[..., :3] != 255, axis=-1
    )
    assert np.any(changed), "expected at least one pixel to fall in the scorch band"

    changed_rgb = out[changed][:, :3].astype(np.float64)
    mean_dist = float(np.linalg.norm(changed_rgb - target[None, :], axis=1).mean())
    assert mean_dist < orig_dist


def test_film_burn_zone_weights_are_a_partition_of_unity():
    """The four zone weights must sum to exactly 1 everywhere, which is
    what makes the composite a genuine blend rather than a `where`
    cascade with seams. It holds only because the three smoothstep bands
    are laid out edge-to-edge (`0..c`, `c..2c`, `2c..3c`) so each one
    saturates before the next begins — overlap the bands and this
    silently stops being true, hence the guard."""
    rng = np.random.default_rng(11)

    for char_w in (1e-3, 0.05, 0.25):
        burn = rng.uniform(-0.5, 1.5, size=(64, 64))

        on = _smoothstep(0.0, char_w, burn)
        scorched = _smoothstep(char_w, 2.0 * char_w, burn)
        holed = _smoothstep(2.0 * char_w, 3.0 * char_w, burn)

        total = (
            (1.0 - on)  # intact
            + on * (1.0 - scorched)  # blister
            + scorched * (1.0 - holed)  # scorch
            + holed  # burn-through
        )
        np.testing.assert_allclose(total, 1.0, atol=1e-12)


def test_film_burn_fully_transparent_input_does_not_crash():
    img = np.zeros((16, 16, 4), dtype=np.uint8)

    out = film_burn(
        img,
        {"progress": 0.7, "count": 3, "bubble": 0.6, "hole": "transparent", "seed": 8},
    )

    assert out.shape == img.shape
    assert out.dtype == np.uint8
