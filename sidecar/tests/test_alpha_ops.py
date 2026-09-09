"""Unit tests for the alpha-writing ops introduced in Epic 16 — `dilate`
and `erode` (story 2), `edge_noise` (story 3). Shared battery coverage
(shape/dtype, no-mutate, determinism, passthrough-suite exclusion) lives
in `test_flavour_ops.py`; this file is the semantic contract from
`guidance/projects/oblique/features/16-alpha-and-edges/
dilate-and-erode.md` and `edge-noise.md`.
"""

from __future__ import annotations

import numpy as np
import pytest

from ops import OPS
from ops.dilate import dilate
from ops.edge_noise import edge_noise
from ops.erode import erode


def _disc(h: int, w: int, radius: float, colour: tuple[int, int, int]) -> np.ndarray:
    """White(ish)-on-transparent disc, `colour` opaque inside `radius` px
    of the canvas centre, fully transparent outside — the vector-mask
    shape the story's acceptance is written against."""
    img = np.zeros((h, w, 4), dtype=np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    cy, cx = h / 2.0, w / 2.0
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    inside = dist <= radius
    img[inside, 0] = colour[0]
    img[inside, 1] = colour[1]
    img[inside, 2] = colour[2]
    img[inside, 3] = 255
    return img


def _soft_disc(
    h: int, w: int, radius: float, colour: tuple[int, int, int], ramp_px: float = 1.0
) -> np.ndarray:
    """White(ish)-on-transparent disc with a `ramp_px`-wide anti-aliased
    edge, used for the strong-displacement `edge_noise` tests below —
    matches the review finding's measurement setup."""
    img = np.zeros((h, w, 4), dtype=np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    cy, cx = h / 2.0, w / 2.0
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    coverage = np.clip((radius - dist) / ramp_px + 0.5, 0.0, 1.0)
    img[..., 0] = colour[0]
    img[..., 1] = colour[1]
    img[..., 2] = colour[2]
    img[..., 3] = np.round(coverage * 255.0).astype(np.uint8)
    return img


def _coverage_radius(alpha: np.ndarray, threshold: int = 127) -> float:
    """Approximate radius of the opaque region: farthest covered pixel
    from the canvas centre, in px."""
    h, w = alpha.shape
    cy, cx = h / 2.0, w / 2.0
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    covered = alpha >= threshold
    if not np.any(covered):
        return 0.0
    return float(dist[covered].max())


# --- registration -----------------------------------------------------


def test_dilate_and_erode_registered_writes_alpha():
    assert OPS["dilate"].writes_alpha is True
    assert OPS["erode"].writes_alpha is True


def test_dilate_and_erode_params_are_spatial_scale():
    for name in ("dilate", "erode"):
        params = {p["name"]: p for p in OPS[name].to_dict()["params"]}
        assert params["radius"]["scale"] == "spatial"


# --- degenerate cases ---------------------------------------------------


def test_dilate_on_fully_opaque_image_is_a_no_op():
    rng = np.random.default_rng(0)
    img = rng.integers(0, 256, size=(24, 24, 3), dtype=np.uint8)
    img = np.dstack([img, np.full((24, 24), 255, dtype=np.uint8)])

    out = dilate(img, {"radius": 3.0})

    np.testing.assert_array_equal(out, img)


def test_radius_zero_is_identity_for_both_ops():
    rng = np.random.default_rng(1)
    img = rng.integers(0, 256, size=(24, 24, 4), dtype=np.uint8)

    np.testing.assert_array_equal(dilate(img, {"radius": 0.0}), img)
    np.testing.assert_array_equal(erode(img, {"radius": 0.0}), img)


def test_negative_radius_is_identity_for_both_ops():
    rng = np.random.default_rng(2)
    img = rng.integers(0, 256, size=(24, 24, 4), dtype=np.uint8)

    np.testing.assert_array_equal(dilate(img, {"radius": -5.0}), img)
    np.testing.assert_array_equal(erode(img, {"radius": -5.0}), img)


def test_ops_do_not_mutate_input():
    rng = np.random.default_rng(3)
    img = rng.integers(0, 256, size=(24, 24, 4), dtype=np.uint8)
    before = img.copy()

    dilate(img, {"radius": 3.0})
    erode(img, {"radius": 3.0})

    np.testing.assert_array_equal(img, before)


# --- grow / shrink --------------------------------------------------------


def test_dilate_grows_disc_radius_and_band_is_white_not_black():
    img = _disc(48, 48, radius=10, colour=(255, 255, 255))

    out = dilate(img, {"radius": 4.0})

    grown_radius = _coverage_radius(out[..., 3])
    assert grown_radius > _coverage_radius(img[..., 3]) + 2.0

    # The newly-covered band (between the original disc edge and the new
    # one) must be white, not black and not the transparent background's
    # arbitrary (here: zero) RGB.
    h, w = out.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((yy - h / 2.0) ** 2 + (xx - w / 2.0) ** 2)
    band = (dist > 11.0) & (dist < 13.0) & (out[..., 3] > 127)
    assert np.any(band), "expected some newly-covered band pixels to check"
    assert np.all(out[..., 0][band] > 200)
    assert np.all(out[..., 1][band] > 200)
    assert np.all(out[..., 2][band] > 200)


def test_erode_shrinks_disc_radius():
    img = _disc(48, 48, radius=15, colour=(200, 60, 60))

    out = erode(img, {"radius": 4.0})

    shrunk_radius = _coverage_radius(out[..., 3])
    assert shrunk_radius < _coverage_radius(img[..., 3]) - 2.0


def test_erode_leaves_rgb_untouched():
    img = _disc(32, 32, radius=12, colour=(200, 60, 60))

    out = erode(img, {"radius": 3.0})

    np.testing.assert_array_equal(out[..., :3], img[..., :3])


# --- round trip -----------------------------------------------------------


def test_dilate_then_erode_approximately_round_trips():
    img = _disc(48, 48, radius=14, colour=(255, 255, 255))

    grown = dilate(img, {"radius": 4.0})
    back = erode(grown, {"radius": 4.0})

    # Allow tolerance for the soft edge the asymmetric premultiply
    # recovery introduces; the coverage radius should still land close to
    # the original.
    orig_r = _coverage_radius(img[..., 3])
    back_r = _coverage_radius(back[..., 3])
    assert abs(orig_r - back_r) <= 2.0


# --- feathered edges stay soft ---------------------------------------------


def test_feathered_edge_stays_soft_not_hardened():
    h, w = 1, 40
    ramp = np.clip(np.linspace(-50, 305, w), 0, 255).astype(np.uint8)
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., :3] = 255
    img[..., 3] = ramp

    out = dilate(img, {"radius": 3.0})

    alpha = out[0, :, 3].astype(np.int32)
    # A soft ramp stays a ramp: several distinct intermediate alpha
    # values, not a single hard step from 0 to 255.
    intermediate = np.sum((alpha > 10) & (alpha < 245))
    assert intermediate >= 5


# --- sub-pixel radius ------------------------------------------------------


def test_subpixel_radius_still_visibly_changes_alpha():
    img = _disc(32, 32, radius=10, colour=(255, 255, 255))

    for radius in (0.5, 0.25):
        out_dilate = dilate(img, {"radius": radius})
        out_erode = erode(img, {"radius": radius})

        assert not np.array_equal(out_dilate[..., 3], img[..., 3]), radius
        assert not np.array_equal(out_erode[..., 3], img[..., 3]), radius


# --- edge_noise (story 3) --------------------------------------------------


def test_edge_noise_registered_writes_alpha():
    assert OPS["edge_noise"].writes_alpha is True


def test_edge_noise_scale_param_is_spatial_amount_and_seed_are_not():
    params = {p["name"]: p for p in OPS["edge_noise"].to_dict()["params"]}
    assert params["scale"]["scale"] == "spatial"
    assert params["amount"]["scale"] == "none"
    assert params["seed"]["scale"] == "none"


def test_edge_noise_on_fully_opaque_image_is_a_no_op_at_any_amount():
    rng = np.random.default_rng(0)
    img = rng.integers(0, 256, size=(32, 32, 3), dtype=np.uint8)
    img = np.dstack([img, np.full((32, 32), 255, dtype=np.uint8)])

    for amount in (0.1, 0.4, 1.0):
        out = edge_noise(img, {"amount": amount, "scale": 12.0, "seed": 3})
        np.testing.assert_array_equal(out, img)


def test_edge_noise_amount_zero_is_identity():
    img = _disc(48, 48, radius=15, colour=(255, 255, 255))

    out = edge_noise(img, {"amount": 0.0, "scale": 12.0, "seed": 5})

    np.testing.assert_array_equal(out, img)


def test_edge_noise_does_not_mutate_input():
    img = _disc(48, 48, radius=15, colour=(255, 255, 255))
    before = img.copy()

    edge_noise(img, {"amount": 0.6, "scale": 12.0, "seed": 5})

    np.testing.assert_array_equal(img, before)


def test_edge_noise_boundary_is_irregular_but_centre_stays_solid_white():
    img = _disc(64, 64, radius=20, colour=(255, 255, 255))

    out = edge_noise(img, {"amount": 1.0, "scale": 12.0, "seed": 5})

    # Boundary becomes irregular: alpha along the original edge radius is
    # no longer uniform.
    h, w = out.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((yy - h / 2.0) ** 2 + (xx - w / 2.0) ** 2)
    ring = (dist > 18.0) & (dist < 22.0)
    ring_alpha = out[..., 3][ring]
    assert ring_alpha.std() > 5.0

    # Centre stays fully opaque and white.
    centre = out[h // 2 - 2 : h // 2 + 2, w // 2 - 2 : w // 2 + 2]
    assert np.all(centre[..., 3] == 255)
    assert np.all(centre[..., 0] == 255)
    assert np.all(centre[..., 1] == 255)
    assert np.all(centre[..., 2] == 255)


def test_edge_noise_rgb_untouched():
    img = _disc(48, 48, radius=15, colour=(200, 60, 60))

    out = edge_noise(img, {"amount": 0.8, "scale": 12.0, "seed": 5})

    np.testing.assert_array_equal(out[..., :3], img[..., :3])


def test_edge_noise_is_deterministic_for_same_seed_and_varies_by_seed():
    img = _disc(48, 48, radius=15, colour=(255, 255, 255))
    params = {"amount": 0.6, "scale": 12.0, "seed": 42}

    out1 = edge_noise(img, params)
    out2 = edge_noise(img, params)
    np.testing.assert_array_equal(out1, out2)

    out_diff_seed = edge_noise(img, {**params, "seed": 43})
    assert not np.array_equal(out1, out_diff_seed)


def test_edge_noise_scale_changes_texture():
    img = _disc(64, 64, radius=20, colour=(255, 255, 255))
    params = {"amount": 0.8, "seed": 9}

    out_a = edge_noise(img, {**params, "scale": 8.0})
    out_b = edge_noise(img, {**params, "scale": 16.0})

    assert not np.array_equal(out_a[..., 3], out_b[..., 3])


def test_edge_noise_amount_changes_depth_at_fixed_scale():
    img = _disc(64, 64, radius=20, colour=(255, 255, 255))
    params = {"scale": 12.0, "seed": 9}

    out_low = edge_noise(img, {**params, "amount": 0.2})
    out_high = edge_noise(img, {**params, "amount": 0.9})

    assert not np.array_equal(out_low[..., 3], out_high[..., 3])


def test_edge_noise_draft_and_full_res_have_comparable_boundary_roughness():
    """`scale` is `scale: "spatial"` — a DRAFT cook (1/8 res) arrives with
    `scale` pre-divided by 8, so the tear reads as the same character at
    every resolution level. Approximate that here directly rather than
    running the resolution ladder."""
    full = _disc(96, 96, radius=30, colour=(255, 255, 255))
    draft = _disc(12, 12, radius=30 / 8, colour=(255, 255, 255))

    out_full = edge_noise(full, {"amount": 0.8, "scale": 12.0, "seed": 9})
    out_draft = edge_noise(draft, {"amount": 0.8, "scale": 12.0 / 8, "seed": 9})

    def roughness_fraction(alpha: np.ndarray, radius: float) -> float:
        h, w = alpha.shape
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.sqrt((yy - h / 2.0) ** 2 + (xx - w / 2.0) ** 2)
        band = (dist > radius - 3) & (dist < radius + 3)
        return float((alpha[band] < 200).mean())

    frac_full = roughness_fraction(out_full[..., 3], 30)
    frac_draft = roughness_fraction(out_draft[..., 3], 30 / 8)

    # Both should show a meaningfully torn boundary (some band pixels
    # knocked well below full opacity) — not an exact numeric match.
    assert frac_full > 0.05
    assert frac_draft > 0.05


def test_edge_noise_amount_1_displaces_boundary_by_roughly_a_noise_cell():
    """Review finding (2026-09-10): the perturb-alpha-by-value recipe was
    too weak to ever move the boundary — max delta ~11/255 and a ~3.5 px
    band at amount=1, scale=12. The warp variant must displace the
    boundary by pixels, not alpha units: at amount=1 it should knock a
    good few dozen pixels in a band at least 6 px wide by more than
    64/255."""
    img = _soft_disc(200, 200, radius=60, colour=(255, 255, 255), ramp_px=1.0)

    out = edge_noise(img, {"amount": 1.0, "scale": 12.0, "seed": 1})

    h, w = out.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((yy - h / 2.0) ** 2 + (xx - w / 2.0) ** 2)

    delta = np.abs(out[..., 3].astype(np.int32) - img[..., 3].astype(np.int32))
    changed = delta > 64
    assert changed.sum() > 30, "expected dozens of pixels displaced by >64/255"

    # Radial band spanned by strongly-changed pixels should be at least
    # 6 px wide (the review's minimum), centred near the original edge.
    band_dists = dist[changed]
    assert band_dists.max() - band_dists.min() >= 6.0


def test_edge_noise_amount_0_4_visibly_changes_pixels():
    img = _soft_disc(200, 200, radius=60, colour=(255, 255, 255), ramp_px=1.0)

    out = edge_noise(img, {"amount": 0.4, "scale": 12.0, "seed": 1})

    delta = np.abs(out[..., 3].astype(np.int32) - img[..., 3].astype(np.int32))
    assert delta.max() > 64
    assert (delta > 64).sum() > 20


# --- edge_noise `profile` param (backlog 2026-09-10) -----------------------


def test_edge_noise_profile_registered_as_enum_with_smooth_default():
    params = {p["name"]: p for p in OPS["edge_noise"].to_dict()["params"]}
    profile = params["profile"]
    assert profile["type"] == "enum"
    assert profile["default"] == "smooth"
    assert set(profile["choices"]) == {"smooth", "linear", "saw", "rect", "straight"}


# SHA-256 of the full RGBA output of the pre-`profile` op (commit ae3d0f4)
# on `_soft_disc(120, 120, radius=40, colour=(200, 120, 60), ramp_px=1.0)`.
# Pinned on 2026-09-10 while the two implementations were verified equal.
_PRE_PROFILE_DIGESTS = {
    (0.4, 12.0, 1): "f8a8195d243272cb553fa6ec93eb8010b0cee592c7957bfd65ac8fcc06241710",
    (1.0, 8.0, 7): "7c25340a5a536edf6b359a4d09b7ca222ba08b5a22c9ed243435b67bd3ff9e44",
    (0.2, 24.0, 99): "5651ae04c6a51a3e2530d66142cc5e9eba4fde2f74e347f01c0df91a00a33d66",
}


def test_edge_noise_smooth_profile_is_byte_identical_to_pre_profile_op():
    """`profile` defaults to `smooth`, which must reproduce the pre-`profile`
    op's output exactly for every existing param combination — the whole
    point of a non-breaking default. Pinned digests, not a git lookup, so
    the guard survives the commit that introduces the param."""
    import hashlib

    img = _soft_disc(120, 120, radius=40, colour=(200, 120, 60), ramp_px=1.0)
    for (amount, scale, seed), digest in _PRE_PROFILE_DIGESTS.items():
        params = {"amount": amount, "scale": scale, "seed": seed}
        explicit = edge_noise(img, {**params, "profile": "smooth"})
        default = edge_noise(img, params)
        assert hashlib.sha256(explicit.tobytes()).hexdigest() == digest
        np.testing.assert_array_equal(default, explicit)


@pytest.mark.parametrize("profile", ["linear", "saw", "rect", "straight"])
def test_edge_noise_non_smooth_profiles_differ_from_smooth_but_keep_interior_and_opaque_noop(
    profile,
):
    img = _soft_disc(200, 200, radius=60, colour=(255, 255, 255), ramp_px=1.0)
    params = {"amount": 0.8, "scale": 12.0, "seed": 5}

    out_smooth = edge_noise(img, {**params, "profile": "smooth"})
    out_profile = edge_noise(img, {**params, "profile": profile})

    assert not np.array_equal(out_smooth[..., 3], out_profile[..., 3])

    # Interior stays fully opaque regardless of profile.
    h, w = img.shape[:2]
    cy, cx = h // 2, w // 2
    assert out_profile[cy, cx, 3] == 255

    # RGB untouched.
    assert np.array_equal(out_profile[..., :3], img[..., :3])

    # A fully-opaque input is still an exact no-op copy under every profile.
    opaque = np.full((60, 60, 4), 255, dtype=np.uint8)
    out_opaque = edge_noise(opaque, {**params, "profile": profile})
    np.testing.assert_array_equal(out_opaque, opaque)


@pytest.mark.parametrize("profile", ["rect", "straight"])
def test_edge_noise_rect_and_straight_field_is_piecewise_constant(profile):
    """The distinguishing feature of `rect`/`straight` vs `smooth`: the
    underlying noise field is flat across whole cells (nearest-neighbour
    upsample of the low-res field), so a short run of pixels within one
    cell shows very few distinct field values — unlike the
    continuously-varying bicubic field."""
    from ops.edge_noise import _noise_field

    field = _noise_field(200, 200, scale=12.0, seed=5, profile=profile)

    row = 100
    col_lo, col_hi = 158, 162  # 4 px, inside a 12- (or 36-)px cell
    segment = field[row, col_lo:col_hi]
    assert len(np.unique(np.round(segment, 6))) <= 1

    field_smooth = _noise_field(200, 200, scale=12.0, seed=5, profile="smooth")
    assert not np.allclose(field, field_smooth)


def test_edge_noise_linear_profile_is_piecewise_linear_between_dots():
    """`linear` connects the noise points with straight runs: within one
    cell the field's second difference along a row is ~0."""
    from ops.edge_noise import _noise_field

    field = _noise_field(64, 64, 8.0, 3, "linear")
    # Low-res pixel centres land at 3.5, 11.5, 19.5, ... in full-res
    # coordinates, so 4..11 lies strictly between two dots. float32
    # resampling, hence the tolerance.
    row = field[12:19, 4:12].astype(np.float64)
    second_diff = np.diff(row, n=2, axis=1)
    assert np.all(np.abs(second_diff) < 1e-3)
    # And it is not flat (that would be `rect`).
    assert np.abs(np.diff(row, axis=1)).max() > 1e-3
