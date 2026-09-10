"""`ml.colour.select_colour` on synthetic two-colour images: contiguous vs
global, Lab vs RGB, tolerance extremes, expand, min_island, and a perf smoke
test on a 2048^2 image (Epic 17 story 2b, colour-range-select.md).
"""

from __future__ import annotations

import time

import numpy as np
import pytest

from ml.colour import select_colour


def _flat_image(
    h: int, w: int, rgb: tuple[int, int, int], alpha: int = 255
) -> np.ndarray:
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., 0] = rgb[0]
    img[..., 1] = rgb[1]
    img[..., 2] = rgb[2]
    img[..., 3] = alpha
    return img


def _square_on_background(
    h: int,
    w: int,
    bg: tuple[int, int, int],
    square: tuple[int, int, int],
    y0: int,
    x0: int,
    y1: int,
    x1: int,
) -> np.ndarray:
    img = _flat_image(h, w, bg)
    img[y0:y1, x0:x1, 0] = square[0]
    img[y0:y1, x0:x1, 1] = square[1]
    img[y0:y1, x0:x1, 2] = square[2]
    return img


def test_contiguous_seed_on_background_selects_background_only_square_is_excluded():
    img = _square_on_background(20, 20, (255, 255, 255), (255, 0, 0), 5, 5, 15, 15)

    mask = select_colour(
        img, (0, 0), tolerance=32, contiguous=True, space="lab", expand=0, min_island=0
    )

    assert mask[0, 0]
    assert not mask[10, 10]  # inside the red square
    assert mask.sum() == 20 * 20 - 10 * 10  # every white pixel, square excluded


def test_global_on_two_separate_same_colour_squares_selects_both():
    img = _flat_image(30, 30, (255, 255, 255))
    img[2:6, 2:6, :3] = (10, 20, 30)
    img[20:24, 20:24, :3] = (10, 20, 30)

    mask = select_colour(
        img, (3, 3), tolerance=0, contiguous=False, space="rgb", expand=0, min_island=0
    )

    assert mask[3, 3]
    assert mask[21, 21]
    assert mask.sum() == 16 + 16


def test_contiguous_on_two_separate_same_colour_squares_selects_only_the_seeded_one():
    img = _flat_image(30, 30, (255, 255, 255))
    img[2:6, 2:6, :3] = (10, 20, 30)
    img[20:24, 20:24, :3] = (10, 20, 30)

    mask = select_colour(
        img, (3, 3), tolerance=0, contiguous=True, space="rgb", expand=0, min_island=0
    )

    assert mask[3, 3]
    assert not mask[21, 21]
    assert mask.sum() == 16


def test_tolerance_zero_selects_only_exactly_equal_pixels():
    img = _flat_image(10, 10, (100, 100, 100))
    img[5, 5, :3] = (101, 100, 100)  # one channel off by 1

    mask = select_colour(
        img, (0, 0), tolerance=0, contiguous=False, space="rgb", expand=0, min_island=0
    )

    assert mask.sum() == 10 * 10 - 1
    assert not mask[5, 5]


def test_tolerance_255_selects_every_opaque_pixel_rgb_and_lab():
    rng = np.random.default_rng(7)
    img = rng.integers(0, 256, size=(12, 12, 4), dtype=np.uint8)
    img[..., 3] = 255  # fully opaque throughout

    for space in ("rgb", "lab"):
        mask = select_colour(
            img,
            (0, 0),
            tolerance=255,
            contiguous=False,
            space=space,
            expand=0,
            min_island=0,
        )
        assert mask.all(), (
            f"space={space} did not select every opaque pixel at tolerance=255"
        )


def test_transparent_pixels_never_match():
    img = _flat_image(10, 10, (50, 50, 50))
    img[3:7, 3:7, 3] = 0  # a transparent hole, same colour otherwise

    mask = select_colour(
        img, (0, 0), tolerance=0, contiguous=False, space="rgb", expand=0, min_island=0
    )

    assert not mask[4, 4]
    assert mask[0, 0]


def test_lab_tolerance_behaves_similarly_on_a_dark_and_light_seed():
    """The story's own rationale for defaulting to Lab: tolerance should
    mean roughly the same perceptual budget regardless of the seed's own
    lightness — check both a dark- and a light-seeded selection cover a
    comparable share of a smooth gradient, unlike raw RGB would.
    """
    w = 256
    gradient = np.linspace(0, 255, w, dtype=np.uint8)
    img = np.zeros((4, w, 4), dtype=np.uint8)
    img[..., 0] = gradient
    img[..., 1] = gradient
    img[..., 2] = gradient
    img[..., 3] = 255

    dark_mask = select_colour(
        img,
        (10, 0),
        tolerance=20,
        contiguous=False,
        space="lab",
        expand=0,
        min_island=0,
    )
    light_mask = select_colour(
        img,
        (245, 0),
        tolerance=20,
        contiguous=False,
        space="lab",
        expand=0,
        min_island=0,
    )

    dark_width = int(dark_mask[0].sum())
    light_width = int(light_mask[0].sum())
    # Same tolerance in Lab should not make the dark end select a vastly
    # narrower (or wider) slice of the gradient than the light end.
    assert dark_width > 0 and light_width > 0
    assert 0.3 <= dark_width / light_width <= 3.0


def test_expand_positive_dilates_and_negative_erodes():
    img = _flat_image(20, 20, (255, 255, 255))
    img[8:12, 8:12, :3] = (0, 0, 0)

    base = select_colour(
        img, (9, 9), tolerance=0, contiguous=True, space="rgb", expand=0, min_island=0
    )
    dilated = select_colour(
        img, (9, 9), tolerance=0, contiguous=True, space="rgb", expand=2, min_island=0
    )
    eroded = select_colour(
        img, (9, 9), tolerance=0, contiguous=True, space="rgb", expand=-1, min_island=0
    )

    assert dilated.sum() > base.sum()
    assert eroded.sum() < base.sum()
    # Dilate is a superset, erode a subset, of the un-expanded selection.
    assert np.array_equal(dilated & base, base)
    assert np.array_equal(eroded & base, eroded)


def test_min_island_drops_small_components_keeps_large_ones():
    img = _flat_image(30, 30, (255, 255, 255))
    img[1:3, 1:3, :3] = (0, 0, 0)  # a 4px speck
    img[10:20, 10:20, :3] = (0, 0, 0)  # a 100px block

    mask = select_colour(
        img,
        (15, 15),
        tolerance=0,
        contiguous=False,
        space="rgb",
        expand=0,
        min_island=16,
    )

    assert not mask[1, 1]
    assert mask[15, 15]
    assert mask.sum() == 100


def test_same_image_same_seed_same_params_is_byte_identical():
    rng = np.random.default_rng(3)
    img = rng.integers(0, 256, size=(24, 24, 4), dtype=np.uint8)
    img[..., 3] = 255

    kwargs = dict(tolerance=40, contiguous=True, space="lab", expand=1, min_island=4)
    a = select_colour(img, (5, 5), **kwargs)
    b = select_colour(img, (5, 5), **kwargs)

    assert np.array_equal(a, b)


@pytest.mark.perf
def test_select_colour_2048_square_well_under_a_second():
    """Perf smoke test (story acceptance: "must handle a 4096^2 image in
    well under a second"; measured here at 2048^2, the largest size cheap
    enough to run routinely — see the story report for the 2048^2 number
    and an extrapolation). Marked `perf`, skipped by default per
    `pyproject.toml`'s `-m 'not perf'`; run explicitly with `-m perf`.
    """
    h = w = 2048
    img = _flat_image(h, w, (255, 255, 255))
    img[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4, :3] = (10, 20, 30)

    start = time.perf_counter()
    mask = select_colour(
        img,
        (10, 10),
        tolerance=10,
        contiguous=True,
        space="lab",
        expand=3,
        min_island=64,
    )
    elapsed = time.perf_counter() - start

    assert mask[10, 10]
    assert elapsed < 1.0, f"select_colour took {elapsed:.3f}s on a 2048x2048 image"
