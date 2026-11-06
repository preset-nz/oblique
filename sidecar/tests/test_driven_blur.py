"""The driven blur (Epic 27 story 1): kernel against reference, the look it
must give, the op contract and the cook frame.

`ops/_driven_blur.py` is the statement of the maths and its NumPy reference;
`oblique_kernels.driven_blur` is what ships, and architecture decision 11a
holds the two to the same bytes. The agreement tests run the reference, which
is slow, so they stay at a few hundred pixels.
"""

from __future__ import annotations

import numpy as np
import pytest
from handlers.cook import handle_cook
from ops import OPS, D, _kernels, op
from ops import _driven_blur as db
from ops.gaussian_blur import gaussian_blur


def _rgb(h: int, w: int, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 256, (h, w, 3), dtype=np.uint8)


def _object_plane(h: int, w: int, y0: int, y1: int, x0: int, x1: int) -> np.ndarray:
    """Far everywhere (white, full radius) with a near, sharp object (black)."""
    v = np.full((h, w), 255, dtype=np.uint8)
    v[y0:y1, x0:x1] = 0
    return v


def _ramp_plane(h: int, w: int) -> np.ndarray:
    return np.tile(np.linspace(0, 255, w).astype(np.uint8), (h, 1))


def _kernel() -> object:
    # `require` raises when the extension is missing, so a broken build fails
    # these tests instead of letting the reference stand in (decision 11a).
    _kernels.require()
    return _Blur()


class _Blur:
    """The kernel as these tests think of it: RGB and 8-bit plane values in
    and out. The kernel itself takes RGBA and the cook's float32 plane."""

    @staticmethod
    def driven_blur(rgb: np.ndarray, v: np.ndarray, spec: dict) -> np.ndarray:
        h, w = v.shape
        rgba = np.full((h, w, 4), 255, dtype=np.uint8)
        rgba[..., :3] = rgb
        plane = v.astype(np.float32) / np.float32(255.0)
        return _kernels.require().driven_blur(rgba, plane, spec)[..., :3]


# --- kernel against the NumPy reference --------------------------------------

# (height, width, radius, plane). The sizes keep the reference affordable; the
# 200x100 and 256x128 object cases are large enough for the kernel's skip paths
# (16-cell tiles, dead rows, the `may` masks) to leave cells out, where kernel
# and reference could part ways. The ramp at radius 30 reaches four levels.
AGREEMENT = [
    ("random", 48, 64, 6.0, lambda h, w: _rgb(h, w, 11)[..., 0]),
    ("ramp", 48, 64, 30.0, _ramp_plane),
    ("object", 100, 200, 14.0, lambda h, w: _object_plane(h, w, 25, 50, 50, 100)),
    ("small-object", 128, 256, 9.0, lambda h, w: _object_plane(h, w, 60, 70, 100, 115)),
]


@pytest.mark.parametrize(
    ("h", "w", "radius", "plane"),
    [c[1:] for c in AGREEMENT],
    ids=[c[0] for c in AGREEMENT],
)
def test_kernel_matches_the_numpy_reference_byte_for_byte(h, w, radius, plane):
    rgb = _rgb(h, w, seed=h * w)
    v = plane(h, w)
    spec = db.build_spec(radius)

    expected = db.driven_blur_reference(rgb, v, spec)
    got = _kernel().driven_blur(rgb, v, spec)

    assert got.dtype == np.uint8
    np.testing.assert_array_equal(got, expected)


@pytest.mark.parametrize("shape", [(1, 1), (1, 17), (17, 1), (3, 5), (2, 2)])
def test_kernel_matches_the_reference_on_degenerate_shapes(shape):
    h, w = shape
    rgb = _rgb(h, w, seed=5)
    v = _rgb(h, w, seed=6)[..., 0]
    spec = db.build_spec(20.0)

    np.testing.assert_array_equal(
        _kernel().driven_blur(rgb, v, spec), db.driven_blur_reference(rgb, v, spec)
    )


def test_kernel_is_deterministic():
    rgb = _rgb(60, 90, seed=1)
    v = _ramp_plane(60, 90)
    spec = db.build_spec(25.0)

    a = _kernel().driven_blur(rgb, v, spec)
    b = _kernel().driven_blur(rgb, v, spec)

    np.testing.assert_array_equal(a, b)


# --- the look ----------------------------------------------------------------


def _gaussian(img: np.ndarray, sigma: float) -> np.ndarray:
    """Separable float64 Gaussian with edge replication, the yardstick."""
    r = int(np.ceil(4 * sigma))
    t = np.exp(-(np.arange(-r, r + 1) ** 2) / (2 * sigma * sigma))
    t /= t.sum()
    out = img.astype(np.float64)
    for axis in (0, 1):
        pad = [(0, 0)] * 3
        pad[axis] = (r, r)
        padded = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out)
        for i, weight in enumerate(t):
            index = [slice(None)] * 3
            index[axis] = slice(i, i + out.shape[axis])
            acc += weight * padded[tuple(index)]
        out = acc
    return out


@pytest.mark.parametrize("v", [255, 128, 60, 20])
def test_a_uniform_plane_gives_the_plain_gaussian_of_its_own_radius(v):
    radius = 30.0
    n = 400
    rgb = np.kron(_rgb(n // 8, n // 8, seed=2), np.ones((8, 8, 1), dtype=np.uint8))
    plane = np.full((n, n), v, dtype=np.uint8)
    sigma = v / 255.0 * radius

    out = _kernel().driven_blur(rgb, plane, db.build_spec(radius)).astype(np.float64)
    expected = _gaussian(rgb, sigma)

    margin = int(4 * sigma) + 4
    inner = (slice(margin, n - margin),) * 2
    # No ghost: the middle is one Gaussian of its own radius, not a blend of a
    # sharp and a fully blurred copy (that would be tens of levels away).
    assert np.abs(out[inner] - expected[inner]).max() <= 3.0


def test_a_black_plane_leaves_the_picture_untouched():
    rgb = _rgb(40, 50, seed=3)
    out = _kernel().driven_blur(rgb, np.zeros((40, 50), np.uint8), db.build_spec(30.0))
    np.testing.assert_array_equal(out, rgb)


def test_a_sharp_near_object_keeps_its_edge_and_the_background_takes_none_of_it():
    """No halo: the near object is byte-identical, and the blurred background
    beside it holds none of its colour. Near is red, far is blue noise."""
    h, w = 160, 200
    rng = np.random.default_rng(4)
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[..., 2] = rng.integers(60, 256, (h, w), dtype=np.uint8)  # background: blue only
    near = np.zeros((h, w), dtype=bool)
    near[40:120, 60:140] = True
    rgb[near] = (255, 0, 0)
    plane = np.where(near, 0, 255).astype(np.uint8)

    out = _kernel().driven_blur(rgb, plane, db.build_spec(24.0))

    np.testing.assert_array_equal(out[near], rgb[near])
    assert out[~near][:, 0].max() == 0, "red leaked into the background"
    assert out[~near][:, 1].max() == 0
    # ... and the background really was blurred, not left alone
    assert np.abs(out[~near].astype(int) - rgb[~near].astype(int)).mean() > 5


def test_a_blurred_near_object_spreads_over_what_is_behind_it():
    """The lens case: a near object with its own radius bleeds into the far
    background as a lens does (the opposite of the sharp case above)."""
    h, w = 160, 200
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[..., 2] = 255
    rgb[40:120, 60:140] = (255, 0, 0)
    plane = np.full((h, w), 255, dtype=np.uint8)
    plane[40:120, 60:140] = 100  # nearer than the background, still soft

    out = _kernel().driven_blur(rgb, plane, db.build_spec(24.0))

    outside_edge = out[80, 52:60]  # background just left of the object
    assert outside_edge[:, 0].max() > 20, (
        "a soft near edge should reach over the background"
    )


def _exact(rgb: np.ndarray, v: np.ndarray, radius: float) -> np.ndarray:
    """The weighting itself, brute force at full resolution with no pyramid:
    w(p, q) = G_min(sigma_p, sigma_q)(p - q), summed over every q, normalised.
    Slow (every offset, every pixel): small pictures only."""
    h, w = v.shape
    sigma = v.astype(np.float64) / 255.0 * radius
    reach = int(np.ceil(3.0 * sigma.max()))
    # per plane value: cut radius and the unit-sum normaliser of the 2D table
    cut = np.ceil(3.0 * np.arange(256) / 255.0 * radius)
    norm = np.ones(256)
    for k in range(1, 256):
        s = k / 255.0 * radius
        t = np.exp(-(np.arange(-int(cut[k]), int(cut[k]) + 1) ** 2) / (2 * s * s))
        norm[k] = t.sum() ** 2
    padded = np.pad(rgb.astype(np.float64), ((reach,) * 2, (reach,) * 2, (0, 0)))
    pv = np.pad(v.astype(np.int64), reach, constant_values=-1)
    num = np.zeros((h, w, 3))
    den = np.zeros((h, w))
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            sv = pv[reach + dy : reach + dy + h, reach + dx : reach + dx + w]
            m = np.minimum(v.astype(np.int64), sv)
            inside = (sv >= 0) & (dx * dx + dy * dy <= cut[m] ** 2)
            s2 = 2.0 * (m / 255.0 * radius) ** 2
            gauss = np.where(
                m > 0,
                np.exp(-(dx * dx + dy * dy) / np.where(s2 > 0, s2, 1.0)),
                float(dx == 0 and dy == 0),
            )
            wgt = np.where(inside, gauss / norm[m], 0.0)
            num += (
                wgt[..., None]
                * padded[reach + dy : reach + dy + h, reach + dx : reach + dx + w]
            )
            den += wgt
    return np.clip(
        np.rint(num / np.where(den > 0, den, 1.0)[..., None]), 0, 255
    ).astype(np.uint8)


@pytest.mark.parametrize(
    "plane",
    [
        lambda h, w: _object_plane(h, w, 12, 30, 20, 44),
        lambda h, w: np.where(_object_plane(h, w, 12, 30, 20, 44) == 0, 90, 255).astype(
            np.uint8
        ),
        _ramp_plane,
    ],
    ids=["sharp-object", "soft-object", "ramp"],
)
def test_the_pyramid_stays_within_a_few_levels_of_the_exact_weighting(plane):
    """The kernel is a fast way to the weighting above, not a different look:
    against the brute-force sum it is within 4 of 255 on random texture, the
    worst case for any resampling. A halo or a ghost would be tens."""
    h, w, radius = 40, 64, 14.0
    rgb = _rgb(h, w, seed=9)
    v = plane(h, w)

    got = _kernel().driven_blur(rgb, v, db.build_spec(radius)).astype(int)
    exact = _exact(rgb, v, radius).astype(int)

    assert np.abs(got - exact).max() <= 4


# --- speckled planes -----------------------------------------------------------
# A plane with per-pixel noise would put every pixel at a different pyramid
# level, so the kernel (and the reference) median-filter a speckled plane first.
# These hold what that must not cost: a map is left alone, a near object stays
# crisp, and the noisy map looks like its clean self.


def _noisy(plane: np.ndarray, sd: float, seed: int) -> np.ndarray:
    n = np.random.default_rng(seed).normal(0, sd, plane.shape)
    return np.clip(plane + n, 0, 255).astype(np.uint8)


def _smooth_depth(h: int, w: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    return np.clip(255 - np.hypot(yy - h / 2, xx - w / 2) * 2.2, 0, 255).astype(
        np.uint8
    )


def test_a_map_is_left_alone_and_speckle_is_filtered():
    spec = db.build_spec(30.0)
    for v in (
        _ramp_plane(60, 90),
        _smooth_depth(80, 80),
        _object_plane(80, 80, 20, 50, 20, 60),
    ):
        np.testing.assert_array_equal(db.denoise_plane(v, spec), v)

    base = _smooth_depth(120, 120)
    for sd in (24.0, 100.0):
        speckled = _noisy(base, sd, 2)
        cleaned = db.denoise_plane(speckled, spec).astype(int)
        before = np.abs(speckled.astype(int) - base).mean()
        after = np.abs(cleaned - base).mean()
        assert after < before / 2, (sd, before, after)


@pytest.mark.parametrize("sd", [6.0, 24.0, 120.0])
def test_a_sharp_near_object_stays_crisp_in_a_speckled_map(sd):
    h, w = 160, 200
    rng = np.random.default_rng(4)
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[..., 2] = rng.integers(60, 256, (h, w), dtype=np.uint8)
    near = np.zeros((h, w), dtype=bool)
    near[40:120, 60:140] = True
    rgb[near] = (255, 0, 0)
    plane = _noisy(np.full((h, w), 200, dtype=np.uint8), sd, 5)
    plane[near] = 0

    out = _kernel().driven_blur(rgb, plane, db.build_spec(24.0))

    # The median keeps a step edge where it is; only the object's four corner
    # pixels, which have more far neighbours than near, can fall to the far side.
    inner = near.copy()
    for y, x in ((40, 60), (40, 139), (119, 60), (119, 139)):
        inner[y, x] = False
    np.testing.assert_array_equal(out[inner], rgb[inner])
    # a corner pixel that fell to the far side may leave a trace, not a halo
    assert out[~near][:, 0].max() <= 2, "red leaked into the background"


@pytest.mark.parametrize(("sd", "bound"), [(6.0, 1.0), (24.0, 3.0)])
def test_a_speckled_map_looks_like_its_clean_map(sd, bound):
    h = w = 256
    rgb = np.kron(_rgb(h // 8, w // 8, seed=2), np.ones((8, 8, 1), dtype=np.uint8))
    clean = _smooth_depth(h, w)
    spec = db.build_spec(30.0)

    a = _kernel().driven_blur(rgb, clean, spec).astype(int)
    b = _kernel().driven_blur(rgb, _noisy(clean, sd, 3), spec).astype(int)

    assert np.abs(a - b).mean() <= bound


@pytest.mark.parametrize("sd", [24.0, 120.0])
def test_a_speckled_map_stays_near_the_exact_weighting_of_its_filtered_self(sd):
    h, w, radius = 40, 64, 14.0
    rgb = _rgb(h, w, seed=9)
    v = _noisy(_ramp_plane(h, w), sd, 7)
    spec = db.build_spec(radius)

    got = _kernel().driven_blur(rgb, v, spec).astype(int)
    exact = _exact(rgb, db.denoise_plane(v, spec), radius).astype(int)

    assert np.abs(got - exact).max() <= 4


# --- the op and the cook frame -----------------------------------------------


def _frame(h, w, modifiers, planes=(), masks=(), drivers=()):
    """A cook request: image, then mask planes, then driver planes."""
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = _rgb(h, w, seed=h + w)
    rgba[..., 3] = 255
    header = {
        "id": "driven",
        "width": w,
        "height": h,
        "modifiers": modifiers,
    }
    payload = rgba.tobytes()
    if masks:
        header["masks"] = [{"modifierIndex": i, "mask_bytes": w * h} for i, _ in masks]
        payload += b"".join(m.tobytes() for _, m in masks)
    if drivers:
        header["drivers"] = [
            {"modifierIndex": i, "kind": kind, "driver_bytes": w * h}
            for i, kind, _ in drivers
        ]
        payload += b"".join(p.tobytes() for _, _, p in drivers)
    return rgba, header, payload


BLUR = {"type": "gaussian_blur", "params": {"radius": 12.0}}


def test_gaussian_blur_offers_a_radius_driver_and_other_ops_offer_none():
    listed = {name: o.to_dict() for name, o in OPS.items()}

    assert listed["gaussian_blur"]["drivers"] == [
        {
            "kind": "radius",
            "label": "Blur follows a layer",
            "description": listed["gaussian_blur"]["drivers"][0]["description"],
        }
    ]
    assert listed["gaussian_blur"]["drivers"][0]["description"]
    for name, entry in listed.items():
        if name != "gaussian_blur":
            assert "drivers" not in entry, name


def test_registering_two_drivers_of_one_kind_fails_at_import():
    with pytest.raises(ValueError, match="duplicate driver kind"):
        op("twice", drivers=[D("radius", "A"), D("radius", "B")])


def test_a_driven_cook_calls_the_op_with_the_plane_as_float_zero_to_one():
    seen = {}

    @op("probe_driver_contract", drivers=[D("amount", "Amount follows a layer")])
    def probe(img, params, drivers=None):
        seen["drivers"] = drivers
        return img.copy()

    try:
        plane = (np.arange(6, dtype=np.uint8) * 51).reshape(2, 3)
        _, header, payload = _frame(
            2,
            3,
            [{"type": "probe_driver_contract", "params": {}}],
            drivers=[(0, "amount", plane)],
        )
        response, _ = handle_cook(header, payload)
        assert response["ok"] is True
        got = seen["drivers"]["amount"]
        assert got.dtype == np.float32
        assert got.shape == (2, 3)
        np.testing.assert_allclose(got, plane / 255.0, rtol=0, atol=1e-7)

        # No driver attached: the op is called as `fn(img, params)`.
        seen.clear()
        _, header, payload = _frame(
            2, 3, [{"type": "probe_driver_contract", "params": {}}]
        )
        handle_cook(header, payload)
        assert seen["drivers"] is None
    finally:
        OPS.pop("probe_driver_contract")


def test_gaussian_blur_with_a_white_plane_is_the_plain_gaussian_blur():
    h, w = 96, 96
    plane = np.full((h, w), 255, dtype=np.uint8)
    rgba, header, payload = _frame(h, w, [BLUR], drivers=[(0, "radius", plane)])

    response, out = handle_cook(header, payload)

    assert response["ok"] is True
    got = np.frombuffer(out, dtype=np.uint8).reshape(h, w, 4)
    expected = _gaussian(rgba[..., :3], 12.0)
    inner = (slice(48, 49), slice(48, 49))
    # at (48, 48) the window is clear of the border and the reading is exact
    assert np.abs(got[..., :3][inner] - expected[inner]).max() <= 3.0
    np.testing.assert_array_equal(got[..., 3], rgba[..., 3])  # alpha untouched


def test_gaussian_blur_with_a_black_plane_is_the_input():
    h, w = 20, 30
    rgba, header, payload = _frame(
        h, w, [BLUR], drivers=[(0, "radius", np.zeros((h, w), np.uint8))]
    )

    response, out = handle_cook(header, payload)

    assert response["ok"] is True
    assert out == rgba.tobytes()


def test_the_numpy_fallback_gives_the_same_bytes_as_the_kernel(monkeypatch):
    h, w = 24, 32
    plane = _ramp_plane(h, w)
    _, header, payload = _frame(h, w, [BLUR], drivers=[(0, "radius", plane)])

    _, with_kernel = handle_cook(header, payload)
    monkeypatch.setenv("OBLIQUE_KERNELS", "0")
    _, without = handle_cook(header, payload)

    assert with_kernel == without


def test_a_radius_of_zero_is_the_input_even_with_a_driver():
    h, w = 20, 30
    rgba, header, payload = _frame(
        h,
        w,
        [{"type": "gaussian_blur", "params": {"radius": 0.0}}],
        drivers=[(0, "radius", np.full((h, w), 255, np.uint8))],
    )

    _, out = handle_cook(header, payload)

    assert out == rgba.tobytes()


def test_a_mask_blends_the_driven_result():
    h, w = 40, 50
    plane = np.full((h, w), 255, dtype=np.uint8)
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[:, : w // 2] = 255
    rgba, header, payload = _frame(
        h, w, [BLUR], masks=[(0, mask)], drivers=[(0, "radius", plane)]
    )
    _, driven_header, driven_payload = _frame(
        h, w, [BLUR], drivers=[(0, "radius", plane)]
    )

    _, out = handle_cook(header, payload)
    _, driven_only = handle_cook(driven_header, driven_payload)

    got = np.frombuffer(out, dtype=np.uint8).reshape(h, w, 4)
    full = np.frombuffer(driven_only, dtype=np.uint8).reshape(h, w, 4)
    np.testing.assert_array_equal(got[:, : w // 2], full[:, : w // 2])
    np.testing.assert_array_equal(got[:, w // 2 :], rgba[:, w // 2 :])


def test_a_frame_with_no_drivers_key_or_an_empty_one_is_the_old_frame():
    h, w = 16, 16
    _, header, payload = _frame(h, w, [BLUR])
    _, a = handle_cook(header, payload)
    _, b = handle_cook({**header, "drivers": []}, payload)
    assert a == b


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (lambda e: e.update(modifierIndex=3), "out of range"),
        (lambda e: e.update(kind="amount"), "offers no driver"),
        (lambda e: e.update(driver_bytes=5), "must be"),
    ],
)
def test_a_bad_driver_entry_is_refused_with_the_reason(change, reason):
    h, w = 8, 8
    plane = np.zeros((h, w), dtype=np.uint8)
    _, header, payload = _frame(h, w, [BLUR], drivers=[(0, "radius", plane)])
    change(header["drivers"][0])

    response, out = handle_cook(header, payload)

    assert response["ok"] is False
    assert reason in response["error"]
    assert out == b""


def test_an_op_that_offers_no_driver_refuses_one():
    h, w = 8, 8
    plane = np.zeros((h, w), dtype=np.uint8)
    _, header, payload = _frame(
        h, w, [{"type": "invert", "params": {}}], drivers=[(0, "radius", plane)]
    )

    response, _ = handle_cook(header, payload)

    assert response["ok"] is False
    assert "offers no driver 'radius'" in response["error"]


def test_two_drivers_on_one_modifier_are_refused():
    h, w = 8, 8
    plane = np.zeros((h, w), dtype=np.uint8)
    _, header, payload = _frame(
        h, w, [BLUR], drivers=[(0, "radius", plane), (0, "radius", plane)]
    )

    response, _ = handle_cook(header, payload)

    assert response["ok"] is False
    assert "more than one driver" in response["error"]


def test_a_payload_missing_its_driver_plane_is_refused():
    h, w = 8, 8
    plane = np.zeros((h, w), dtype=np.uint8)
    _, header, payload = _frame(h, w, [BLUR], drivers=[(0, "radius", plane)])

    response, _ = handle_cook(header, payload[: -w * h])

    assert response["ok"] is False
    assert "driver(s)" in response["error"]


def test_gaussian_blur_without_a_driver_is_unchanged_when_called_directly():
    img = np.zeros((8, 8, 4), dtype=np.uint8)
    img[..., 3] = 255
    assert gaussian_blur(img, {"radius": 2.0}).shape == img.shape
