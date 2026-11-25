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


def test_registered_as_a_distort_op_that_leaves_alpha_alone():
    entry = OPS["jpeg_corrupt"]
    assert entry.category == "distort"
    assert entry.label == "JPEG Corrupt"
    assert entry.writes_alpha is False
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
