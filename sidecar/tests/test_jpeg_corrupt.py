"""`jpeg_corrupt` (Epic 28, jpeg-corrupt.md): real JPEG damage, spread by a
seeded infection that only ever grows with `progress`."""

from __future__ import annotations

import hashlib
import io

import numpy as np
import pytest
from ops import OPS
from ops import jpeg_corrupt as jc
from PIL import Image

op = OPS["jpeg_corrupt"].fn

# Defaults restated, so a change to one shows up here rather than silently.
BASE = {
    "progress": 0.35,
    "colonies": 3,
    "spores": 0.15,
    "irregularity": 0.6,
    "smear": 4,
    "severity": 3,
    "mode": "shift",
    "quality": 40,
    "chroma": "420",
    "block": 16.0,
    "show": "picture",
    "variant": 0,
    "seed": 0,
}


def textured(h: int = 384, w: int = 256, seed: int = 1) -> np.ndarray:
    """Noisy RGBA with a varying alpha: every block differs from its own
    re-encoding, so a changed block is an infected block."""
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)
    img[..., 3] = rng.integers(0, 256, size=(h, w), dtype=np.uint8)
    return img


def changed_mcus(a: np.ndarray, b: np.ndarray, mcu: int = 16) -> set[tuple[int, int]]:
    diff = (a[..., :3] != b[..., :3]).any(axis=-1)
    ys, xs = np.nonzero(diff)
    return set(zip((ys // mcu).tolist(), (xs // mcu).tolist()))


def infected_set(h: int, w: int, params: dict) -> set[tuple[int, int]]:
    """The MCUs the op infects at block == mcu, from its own helpers."""
    mcu = jc._mcu_size(params["chroma"])
    rows, cols = -(-h // mcu), -(-w // mcu)
    order = jc._infection_order(
        rows,
        cols,
        params["smear"],
        params["colonies"],
        params["spores"],
        params["irregularity"],
        params["seed"],
    )
    n_int = -(-rows * cols // params["smear"])
    count = jc._infected_count(params["progress"], n_int)
    mask = jc._infected_mcus(rows, cols, params["smear"], order, count)
    return set(zip(*(a.tolist() for a in np.nonzero(mask))))


def encoded(img: np.ndarray, smear: int, chroma: str = "420", quality: int = 40):
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(img[..., :3])).save(
        buf,
        "JPEG",
        quality=quality,
        subsampling=2 if chroma == "420" else 0,
        restart_marker_blocks=smear,
    )
    data = buf.getvalue()
    layout = jc._intervals(data)
    assert layout is not None
    return data, *layout


# --- registration --------------------------------------------------------


def test_registered_as_a_distort_op_that_writes_alpha_for_the_damage_view():
    entry = OPS["jpeg_corrupt"]
    assert entry.category == "distort"
    assert entry.label == "JPEG Corrupt"
    assert entry.writes_alpha is True
    assert entry.fn.__name__ == "jpeg_corrupt"


def test_params_match_the_story_and_only_block_is_spatial():
    specs = {p.name: p for p in OPS["jpeg_corrupt"].params}
    assert {n: s.default for n, s in specs.items()} == {
        **BASE,
        "block": 16.0,
    }
    assert [n for n, s in specs.items() if s.scale == "spatial"] == ["block"]
    assert specs["mode"].choices == ("flip", "replace", "shift")
    assert specs["chroma"].choices == ("420", "444")
    assert specs["show"].choices == ("picture", "damage", "colonies")
    assert specs["show"].choice_labels == {
        "picture": "Picture",
        "damage": "Damage",
        "colonies": "Colonies",
    }
    assert specs["show"].label == "Show"
    assert specs["block"].min == 4.0 and specs["block"].max == 128.0


# --- the contract --------------------------------------------------------


def test_progress_zero_returns_the_input_bytes():
    img = textured()
    before = img.copy()
    out = op(img, {**BASE, "progress": 0.0})
    assert out.tobytes() == img.tobytes()
    assert out is not img
    np.testing.assert_array_equal(img, before)


def test_shape_dtype_alpha_and_input_are_kept():
    img = textured()
    before = img.copy()
    out = op(img, {**BASE, "progress": 0.6})
    assert out.shape == img.shape and out.dtype == np.uint8
    np.testing.assert_array_equal(out[..., 3], img[..., 3])
    np.testing.assert_array_equal(img, before)
    assert not np.array_equal(out, img)


def test_same_params_twice_give_the_same_bytes():
    img = textured()
    assert op(img, dict(BASE)).tobytes() == op(img, dict(BASE)).tobytes()


def test_a_stored_result_catches_a_decoder_change():
    """Pillow is pinned by uv.lock; how a decoder reads damaged data isn't
    part of the JPEG standard. If this fails after an upgrade, saved
    documents will look different: decide on purpose, then update the hash.
    (Taken on macOS arm64, Pillow 13.0.0.)"""
    out = op(textured(96, 128), {**BASE, "progress": 0.5})
    assert hashlib.sha256(out.tobytes()).hexdigest() == STORED_HASH


STORED_HASH = "9be9e7de23298982c9d338d121eb650ddb35160e5293f6144dc9f46adee4b06f"


# --- the infection -------------------------------------------------------


def test_a_higher_progress_infects_a_superset():
    img = textured()
    low = changed_mcus(img, op(img, {**BASE, "progress": 0.3}))
    high = changed_mcus(img, op(img, {**BASE, "progress": 0.6}))
    assert low and high
    assert low < high
    assert low <= infected_set(384, 256, {**BASE, "progress": 0.3})


def test_infected_sets_nest_all_the_way_up():
    previous: set = set()
    for progress in np.linspace(0.0, 1.0, 11):
        now = infected_set(384, 256, {**BASE, "progress": float(progress)})
        assert previous <= now
        previous = now
    assert len(previous) == 24 * 16


def test_progress_one_infects_every_block():
    img = textured()
    out = op(img, {**BASE, "progress": 1.0})
    assert len(changed_mcus(img, out)) == 24 * 16


def test_variant_changes_the_pixels_not_the_colonies():
    img = textured()
    a = op(img, {**BASE, "variant": 0})
    b = op(img, {**BASE, "variant": 1})
    assert not np.array_equal(a, b)
    assert changed_mcus(img, a) == changed_mcus(img, b)
    assert changed_mcus(img, a) == infected_set(384, 256, BASE)


def test_seed_moves_the_colonies():
    a = infected_set(384, 256, {**BASE, "seed": 0})
    b = infected_set(384, 256, {**BASE, "seed": 1})
    assert a != b


def test_without_spores_or_noise_the_infection_grows_out_from_the_colony():
    """One colony, smear 1: every infected block is nearer the colony than
    every clean one, and the colony is the first row of the seeded draw."""
    rows, cols, seed = 24, 16, 5
    point = np.random.default_rng(seed).uniform(0, 1, size=(1, 2))[0] * [rows, cols]
    order = jc._infection_order(rows, cols, 1, 1, 0.0, 0.0, seed)
    yy, xx = np.divmod(np.arange(rows * cols), cols)
    dist = np.hypot(yy + 0.5 - point[0], xx + 0.5 - point[1])
    np.testing.assert_array_equal(order, np.argsort(dist, kind="stable"))


def test_colony_one_is_the_same_whatever_the_count():
    """The first colony is the first row of one draw, so the block nearest it
    is among the first infected whether there is one colony or twelve."""
    one = jc._infection_order(24, 16, 1, 1, 0.0, 0.0, 5)
    twelve = jc._infection_order(24, 16, 1, 12, 0.0, 0.0, 5)
    assert one[0] in twelve[: 24 * 16 // 4]


def test_every_spore_count_orders_every_interval_once():
    for spores in (0.0, 0.15, 1.0):
        order = jc._infection_order(24, 16, 4, 3, spores, 0.6, 0)
        assert sorted(order) == list(range(24 * 16 // 4))


def test_damage_stays_in_its_interval_with_smear_one():
    img = textured()
    params = {**BASE, "smear": 1, "progress": 0.5}
    out = op(img, params)
    assert changed_mcus(img, out) <= infected_set(384, 256, params)


@pytest.mark.parametrize("chroma", ["420", "444"])
@pytest.mark.parametrize("mode", ["flip", "replace", "shift"])
def test_a_damaged_decode_differs_from_a_clean_one_only_in_its_own_block(chroma, mode):
    """Raw JPEG level (the op's mask would hide a leak): with a restart marker
    after every block, damage to interval i changes pixels of MCU i only."""
    mcu = jc._mcu_size(chroma)
    img = textured(96, 128)
    data, starts, ends, arr = encoded(img, 1, chroma)
    clean = jc._decode(data)
    cols = -(-128 // mcu)
    for i in (3, 20, 31):
        damaged = jc._decode(
            jc._damage(
                data, starts, ends, arr, np.array([i]), mode, 6, seed=4, variant=2
            )
        )
        r, c = divmod(i, cols)
        ys, xs = np.nonzero((clean != damaged).any(axis=-1))
        assert ys.size
        # 4:4:4 stays exactly in the block. 4:2:0's smoothed colour upsampling
        # reads one chroma sample (2 px) over the edge, so a hit can show 1 px
        # into the next block; the op takes clean blocks from the input, so
        # this never reaches the output.
        edge = 1 if chroma == "420" else 0
        assert ys.min() >= r * mcu - edge and ys.max() < (r + 1) * mcu + edge
        assert xs.min() >= c * mcu - edge and xs.max() < (c + 1) * mcu + edge


@pytest.mark.parametrize("mode", ["flip", "replace", "shift"])
def test_damage_never_touches_the_markers_or_byte_stuffing(mode):
    img = textured(128, 128)
    data, starts, ends, arr = encoded(img, 2, quality=95)
    everything = np.arange(len(starts))
    for variant in range(4):
        damaged = jc._damage(
            data, starts, ends, arr, everything, mode, 16, seed=7, variant=variant
        )
        new = np.frombuffer(damaged, dtype=np.uint8)
        # every 0xFF is still followed by what it was followed by: the same
        # run of marker or stuffing bytes, in the same order
        old_ff = np.flatnonzero(arr[:-1] == 0xFF)
        new_ff = np.flatnonzero(new[:-1] == 0xFF)
        np.testing.assert_array_equal(arr[old_ff + 1], new[new_ff + 1])
        assert (new == 0xFF).sum() == (arr == 0xFF).sum()
        assert damaged != data


def test_flip_changes_each_byte_it_touches_and_never_writes_ff():
    img = textured(64, 64)
    data, starts, ends, arr = encoded(img, 1)
    damaged = np.frombuffer(
        jc._damage(
            data,
            starts,
            ends,
            arr,
            np.arange(len(starts)),
            "flip",
            16,
            seed=1,
            variant=0,
        ),
        dtype=np.uint8,
    )
    assert len(damaged) == len(arr)
    assert (damaged != arr).any()
    assert (damaged == 0xFF).sum() == (arr == 0xFF).sum()


def test_shift_changes_the_length_of_the_file():
    img = textured(64, 64)
    data, starts, ends, arr = encoded(img, 1)
    lengths = {
        len(
            jc._damage(
                data,
                starts,
                ends,
                arr,
                np.arange(len(starts)),
                "shift",
                8,
                seed=1,
                variant=v,
            )
        )
        for v in range(3)
    }
    assert lengths != {len(data)}


# --- sizes and modes -----------------------------------------------------


@pytest.mark.parametrize("chroma", ["420", "444"])
@pytest.mark.parametrize("mode", ["flip", "replace", "shift"])
@pytest.mark.parametrize("size", [(64, 64), (1, 1), (33, 17)])
def test_every_mode_runs_on_awkward_sizes(mode, size, chroma):
    h, w = size
    img = textured(h, w, seed=3)
    out = op(img, {**BASE, "mode": mode, "chroma": chroma, "progress": 1.0})
    assert out.shape == img.shape and out.dtype == np.uint8
    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_partial_blocks_at_the_edge_are_infected_whole_and_clean_ones_stay_clean():
    img = textured(33, 17, seed=3)  # 3 x 2 MCUs, the last row and column partial
    params = {**BASE, "smear": 1, "progress": 0.5}
    out = op(img, params)
    infected = infected_set(33, 17, params)
    assert infected and len(infected) < 6
    assert changed_mcus(img, out) == infected
    clean = np.ones(img.shape[:2], dtype=bool)
    for r, c in infected:
        clean[r * 16 : (r + 1) * 16, c * 16 : (c + 1) * 16] = False
    np.testing.assert_array_equal(out[clean], img[clean])


@pytest.mark.parametrize("block", [4.0, 8.0, 40.0])
def test_block_size_runs_and_keeps_the_shape(block):
    img = textured(96, 128, seed=5)
    out = op(img, {**BASE, "block": block, "progress": 0.6})
    assert out.shape == img.shape
    assert not np.array_equal(out, img)


def test_a_draft_keeps_the_same_blocks_in_proportion():
    """Half the picture with half the block size lands on the same MCU grid,
    so the same blocks are infected."""
    full = textured(192, 256, seed=2)
    half = np.asarray(
        Image.fromarray(full).resize((128, 96), Image.Resampling.BOX)
    ).copy()
    a = changed_mcus(full, op(full, {**BASE, "block": 16.0}), 16)
    b = changed_mcus(half, op(half, {**BASE, "block": 8.0}), 8)
    assert a == b and a


# --- when decoding fails -------------------------------------------------


def test_a_decode_that_always_fails_returns_the_input(monkeypatch):
    def broken(data):
        raise OSError("broken data stream")

    monkeypatch.setattr(jc, "_decode", broken)
    img = textured()
    out = op(img, {**BASE, "progress": 0.7})
    assert out.tobytes() == img.tobytes()
    assert out is not img


def test_one_failed_decode_is_retried_with_another_variant(monkeypatch):
    real = jc._decode
    calls = []

    def flaky(data):
        calls.append(len(data))
        if len(calls) == 1:
            raise OSError("broken data stream")
        return real(data)

    monkeypatch.setattr(jc, "_decode", flaky)
    img = textured()
    out = op(img, {**BASE, "progress": 0.7})
    assert len(calls) == 2
    monkeypatch.setattr(jc, "_decode", real)
    retried = op(img, {**BASE, "progress": 0.7, "variant": 1_000_003})
    assert out.tobytes() == retried.tobytes()
    assert out.tobytes() != img.tobytes()


def test_a_marker_count_that_isnt_the_grids_returns_the_input(monkeypatch):
    monkeypatch.setattr(jc, "_intervals", lambda data: None)
    img = textured()
    assert op(img, dict(BASE)).tobytes() == img.tobytes()


def test_truncated_image_loading_is_not_left_on():
    from PIL import ImageFile

    op(textured(64, 64), {**BASE, "progress": 1.0})
    assert ImageFile.LOAD_TRUNCATED_IMAGES is False


# --- show ----------------------------------------------------------------


def block_view(a: np.ndarray, mcu: int = 16) -> np.ndarray:
    """`(rows, cols, mcu, mcu, ...)` blocks of a picture whose sides are whole MCUs."""
    h, w = a.shape[:2]
    rest = a.shape[2:]
    return a.reshape(h // mcu, mcu, w // mcu, mcu, *rest).swapaxes(1, 2)


def infected_mask(h: int, w: int, params: dict) -> np.ndarray:
    mcu = jc._mcu_size(params["chroma"])
    mask = np.zeros((-(-h // mcu), -(-w // mcu)), dtype=bool)
    for r, c in infected_set(h, w, params):
        mask[r, c] = True
    return mask


def test_the_default_show_is_the_picture():
    specs = {p.name: p for p in OPS["jpeg_corrupt"].params}
    assert specs["show"].default == "picture"
    img = textured()
    assert op(img, {**BASE, "show": "picture"}).tobytes() == (
        op(img, {k: v for k, v in BASE.items() if k != "show"}).tobytes()
    )


def test_an_unknown_show_is_the_picture():
    img = textured()
    assert op(img, {**BASE, "show": "x"}).tobytes() == op(img, dict(BASE)).tobytes()


def test_damage_is_whole_blocks_either_opaque_or_transparent():
    img = textured()
    out = op(img, {**BASE, "show": "damage", "progress": 0.6})
    blocks = block_view(out[..., 3])
    flat = blocks.reshape(*blocks.shape[:2], -1)
    opaque = (flat == img_alpha_blocks(img)).all(axis=-1)
    clear = (flat == 0).all(axis=-1)
    assert (opaque | clear).all()
    assert opaque.any() and clear.any()


def img_alpha_blocks(img: np.ndarray) -> np.ndarray:
    blocks = block_view(img[..., 3])
    return blocks.reshape(*blocks.shape[:2], -1)


def test_damage_keeps_the_pictures_pixels_in_its_blocks_and_the_inputs_rgb_elsewhere():
    img = textured()
    img[..., 3] = np.maximum(img[..., 3], 1)  # so alpha 0 means "not damaged"
    params = {**BASE, "progress": 0.6}
    picture = op(img, params)
    out = op(img, {**params, "show": "damage"})
    clear = out[..., 3] == 0
    assert clear.any() and (~clear).any()
    np.testing.assert_array_equal(out[~clear, :3], picture[~clear, :3])
    np.testing.assert_array_equal(out[~clear, 3], img[~clear, 3])
    np.testing.assert_array_equal(out[clear, :3], img[clear, :3])
    # every damaged block is an infected block
    infected = np.repeat(np.repeat(infected_mask(384, 256, params), 16, 0), 16, 1)
    assert not (~clear & ~infected).any()


def test_damage_with_a_transparent_input_pixel_stays_transparent():
    img = textured()
    img[:16, :16, 3] = 0  # a whole block, whatever it does
    out = op(img, {**BASE, "show": "damage", "progress": 1.0})
    assert (out[:16, :16, 3] == 0).all()


def test_an_infected_block_the_decode_left_unchanged_is_transparent(monkeypatch):
    """Hits land in only some infected intervals, so the others decode exactly
    as a clean file would, and that is not damage however big the JPEG's own
    quality loss on this noisy picture is."""
    img = textured()
    img[..., 3] = np.maximum(img[..., 3], 1)
    # 4:4:4 has no chroma leaking into the next block, so "left unchanged" is exact
    params = {
        **BASE,
        "smear": 1,
        "progress": 0.6,
        "show": "damage",
        "chroma": "444",
        "block": 8.0,
    }
    infected = infected_mask(384, 256, params)
    real = jc._damage
    hit = {"first": None}

    def some_of_them(data, starts, ends, arr, which, *rest):
        keep = which[::2]
        hit["first"] = set(keep.tolist())
        return real(data, starts, ends, arr, keep, *rest)

    monkeypatch.setattr(jc, "_damage", some_of_them)
    out = op(img, params)
    cols = 256 // 8
    opaque = block_view(out[..., 3], 8).reshape(48, cols, -1).max(axis=-1) > 0
    expected = np.zeros(48 * cols, dtype=bool)
    expected[sorted(hit["first"])] = True
    # an infected block that wasn't hit is transparent; a hit one is opaque
    assert not (opaque.reshape(-1) & ~expected).any()
    assert opaque.sum() > 0
    assert (infected.reshape(-1) & ~expected).sum() > 0
    np.testing.assert_array_equal(
        out[out[..., 3] == 0][:, :3], img[out[..., 3] == 0][:, :3]
    )


def test_a_decode_that_changes_nothing_leaves_the_layer_transparent(monkeypatch):
    monkeypatch.setattr(jc, "_damage", lambda data, *rest: data)
    img = textured()
    out = op(img, {**BASE, "show": "damage", "progress": 1.0})
    assert (out[..., 3] == 0).all()
    np.testing.assert_array_equal(out[..., :3], img[..., :3])


def test_damage_at_progress_zero_is_transparent_with_the_inputs_rgb():
    img = textured()
    out = op(img, {**BASE, "show": "damage", "progress": 0.0})
    assert (out[..., 3] == 0).all()
    np.testing.assert_array_equal(out[..., :3], img[..., :3])


def test_damage_that_cannot_be_decoded_is_transparent_not_the_picture(monkeypatch):
    def broken(data):
        raise OSError("broken data stream")

    monkeypatch.setattr(jc, "_decode", broken)
    img = textured()
    out = op(img, {**BASE, "show": "damage", "progress": 0.7})
    assert (out[..., 3] == 0).all()
    np.testing.assert_array_equal(out[..., :3], img[..., :3])


def test_damage_follows_the_block_size_and_stays_whole_blocks():
    img = textured(96, 128, seed=5)
    out = op(img, {**BASE, "show": "damage", "block": 40.0, "progress": 0.8})
    assert out.shape == img.shape
    assert set(np.unique(out[..., 3] == 0)) == {True, False}


def smooth_picture(h: int = 96, w: int = 128) -> np.ndarray:
    """Soft colour gradients with a little grain, closer to a photo than noise."""
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    grain = np.random.default_rng(3).normal(0, 3, size=(h, w, 3))
    rgb = np.stack(
        [
            128 + 100 * np.sin(xx / 17),
            128 + 100 * np.sin(yy / 13 + 1),
            128 + 100 * np.sin((xx + yy) / 23 + 2),
        ],
        axis=-1,
    )
    return np.clip(rgb + grain, 0, 255).astype(np.uint8)


def test_the_damage_threshold_sits_between_chroma_leak_and_a_real_hit():
    """4:2:0 reads one chroma sample over a block's edge, so the block beside a
    hit shifts a little (about 2.4 on the fixture photo); a hit in its own
    block changes it by tens of levels. The constant sits between."""
    smooth = smooth_picture()
    data, starts, ends, arr = encoded(smooth, 1)
    clean = jc._decode(data)
    cols = 8
    for i in (9, 20, 30, 41):
        for mode in ("flip", "replace", "shift"):
            damaged = jc._decode(
                jc._damage(data, starts, ends, arr, np.array([i]), mode, 3, 1, 0)
            )
            means = jc._block_means(damaged, clean, 16)
            r, c = divmod(i, cols)
            assert means[r, c] > jc._DAMAGE_THRESHOLD
            means[r, c] = 0
            assert means.max() < jc._DAMAGE_THRESHOLD


def test_block_means_average_partial_edge_blocks_over_their_own_pixels():
    a = np.zeros((20, 20, 3), dtype=np.uint8)
    b = a.copy()
    b[16:, 16:] = 10  # the 4 x 4 corner block, entirely different
    means = jc._block_means(a, b, 16)
    assert means.shape == (2, 2)
    assert means[1, 1] == 10.0 and means[0, 0] == 0.0


def test_colonies_white_is_exactly_the_infected_blocks():
    img = textured()
    params = {**BASE, "show": "colonies", "progress": 0.45}
    out = op(img, params)
    white = block_view(out[..., 0]).reshape(24, 16, -1)
    assert (white == white[..., :1]).all()  # one value per block
    got = white[..., 0] == 255
    np.testing.assert_array_equal(got, infected_mask(384, 256, params))


def test_colonies_is_opaque_grey_with_the_inputs_alpha():
    img = textured()
    out = op(img, {**BASE, "show": "colonies"})
    np.testing.assert_array_equal(out[..., 0], out[..., 1])
    np.testing.assert_array_equal(out[..., 0], out[..., 2])
    np.testing.assert_array_equal(out[..., 3], img[..., 3])
    assert out.shape == img.shape and out.dtype == np.uint8


def test_colonies_greys_fall_linearly_from_next_to_last_in_infection_order():
    img = textured()
    params = {**BASE, "smear": 1, "show": "colonies", "progress": 0.25}
    out = op(img, params)
    shade = out[::16, ::16, 0].reshape(-1).astype(float)
    order = jc._infection_order(24, 16, 1, 3, 0.15, 0.6, 0)
    count = jc._infected_count(0.25, 24 * 16)
    assert (shade[order[:count]] == 255).all()
    ahead = shade[order[count:]]
    assert ahead[0] == jc._COLONIES_NEXT_GREY
    assert ahead[-1] == jc._COLONIES_LAST_GREY
    assert (np.diff(ahead) <= 0).all()
    steps = np.diff(ahead)
    assert steps.min() >= -2 and steps.max() <= 0  # evenly spaced, to rounding
    assert ahead.max() < 255


def test_colonies_at_progress_zero_is_the_map_not_the_picture():
    img = textured()
    out = op(img, {**BASE, "show": "colonies", "progress": 0.0})
    assert not np.array_equal(out, img)
    assert out[..., 0].max() < 255
    assert out[..., 0].max() == round(jc._COLONIES_NEXT_GREY)


def test_colonies_at_progress_one_is_all_white():
    out = op(textured(), {**BASE, "show": "colonies", "progress": 1.0})
    assert (out[..., :3] == 255).all()


def test_colonies_ignore_variant_quality_severity_and_damage_mode():
    img = textured()
    base = op(img, {**BASE, "show": "colonies"})
    for change in (
        {"variant": 5},
        {"quality": 90},
        {"severity": 12},
        {"mode": "flip"},
    ):
        assert (
            op(img, {**BASE, "show": "colonies", **change}).tobytes() == base.tobytes()
        )


def test_colonies_follow_seed_smear_and_the_block_size():
    img = textured()
    base = op(img, {**BASE, "show": "colonies"}).tobytes()
    for change in ({"seed": 1}, {"smear": 8}, {"block": 32.0}, {"colonies": 6}):
        assert op(img, {**BASE, "show": "colonies", **change}).tobytes() != base


def test_colonies_never_encode_or_decode(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("the colonies map must not touch the JPEG")

    monkeypatch.setattr(jc, "_decode", boom)
    monkeypatch.setattr(jc, "_damage", boom)
    op(textured(), {**BASE, "show": "colonies"})


@pytest.mark.parametrize("size", [(64, 64), (1, 1), (33, 17)])
@pytest.mark.parametrize("show", ["damage", "colonies"])
def test_the_other_views_run_on_awkward_sizes(show, size):
    h, w = size
    img = textured(h, w, seed=3)
    out = op(img, {**BASE, "show": show, "progress": 1.0})
    assert out.shape == img.shape and out.dtype == np.uint8


@pytest.mark.parametrize("show", ["damage", "colonies"])
def test_the_other_views_do_not_mutate_the_input_and_repeat(show):
    img = textured()
    before = img.copy()
    a = op(img, {**BASE, "show": show})
    np.testing.assert_array_equal(img, before)
    assert a.tobytes() == op(img, {**BASE, "show": show}).tobytes()
