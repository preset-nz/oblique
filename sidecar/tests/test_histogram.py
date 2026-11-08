"""Levels' histogram (Epic 27, `features/27-driven-params/levels-curve.md`):
256 bins of the picture as it arrives at a modifier whose op asks, sent back with
the cook, and absent from every cook that doesn't ask."""

from __future__ import annotations

import numpy as np
import pytest
from handlers.cook import HISTOGRAM_BINS, handle_cook, histogram_bins
from ops import OPS, P, op

W, H = 16, 8


def _solid(r: int, g: int, b: int, a: int = 255) -> np.ndarray:
    img = np.empty((H, W, 4), dtype=np.uint8)
    img[...] = (r, g, b, a)
    return img


def _cook(img: np.ndarray, modifiers: list[dict], **extra: object):
    header = {"id": "h", "width": W, "height": H, "modifiers": modifiers, **extra}
    return handle_cook(header, img.tobytes())


def test_only_levels_asks_and_the_list_says_so() -> None:
    asking = sorted(name for name, entry in OPS.items() if entry.histogram)
    assert asking == ["levels"]
    assert OPS["levels"].to_dict()["histogram"] is True
    assert "histogram" not in OPS["invert"].to_dict()


def test_gamma_is_the_curve_widget_and_nothing_else_is_changed() -> None:
    params = {p["name"]: p for p in OPS["levels"].to_dict()["params"]}
    assert params["gamma"]["widget"] == "curve"
    assert params["gamma"]["curve"] == {"black": "black", "white": "white"}
    assert "curve" not in params["black"]
    assert "widget" not in params["black"]
    assert "widget" not in params["white"]
    assert (params["gamma"]["min"], params["gamma"]["max"]) == (0.1, 5.0)


def test_bins_of_a_solid_colour_sit_in_one_bin_per_channel() -> None:
    bins = histogram_bins(_solid(10, 200, 30))
    assert set(bins) == {"luma", "r", "g", "b"}
    assert all(len(v) == HISTOGRAM_BINS for v in bins.values())
    assert bins["r"][10] == bins["g"][200] == bins["b"][30] == W * H
    # Rec. 709: 0.2126*10 + 0.7152*200 + 0.0722*30 = 147.3
    assert bins["luma"][147] == W * H
    assert all(sum(v) == W * H for v in bins.values())


def test_luma_uses_the_rec709_weights() -> None:
    # pure green is 0.7152 * 255 = 182.4, red 0.2126 * 255 = 54.2, blue 18.4
    assert histogram_bins(_solid(0, 255, 0))["luma"][182] == W * H
    assert histogram_bins(_solid(255, 0, 0))["luma"][54] == W * H
    assert histogram_bins(_solid(0, 0, 255))["luma"][18] == W * H


def test_bins_cover_every_value_including_the_ends() -> None:
    ramp = np.zeros((H, W, 4), dtype=np.uint8)
    ramp[..., 3] = 255
    ramp[0, 0, :3] = 255
    bins = histogram_bins(ramp)
    assert bins["luma"][255] == 1
    assert bins["luma"][0] == W * H - 1


def test_transparent_pixels_are_not_counted() -> None:
    img = _solid(255, 255, 255)
    img[: H // 2] = (0, 0, 0, 0)
    bins = histogram_bins(img)
    assert sum(bins["luma"]) == W * H // 2
    assert bins["luma"][0] == 0


def test_does_not_mutate_its_input() -> None:
    img = np.random.default_rng(1).integers(0, 256, (H, W, 4), dtype=np.uint8)
    before = img.copy()
    histogram_bins(img)
    assert np.array_equal(img, before)


def test_cook_returns_the_input_of_the_modifier_that_asks() -> None:
    img = _solid(100, 100, 100)
    mods = [
        {"type": "invert", "params": {}},
        {"type": "levels", "params": {"black": 0, "white": 255, "gamma": 2.0}},
    ]
    response, _ = _cook(img, mods, histograms=[1])
    assert response["ok"] is True
    [entry] = response["histograms"]
    assert entry["modifierIndex"] == 1
    # levels' input is the inverted picture, not the source and not levels' output
    assert entry["r"][155] == W * H
    assert entry["r"][100] == 0


def test_cook_histogram_follows_a_change_above_levels() -> None:
    img = _solid(100, 100, 100)
    levels = {"type": "levels", "params": {}}
    plain, _ = _cook(img, [levels], histograms=[0])
    inverted, _ = _cook(img, [{"type": "invert", "params": {}}, levels], histograms=[1])
    assert plain["histograms"][0]["luma"] != inverted["histograms"][0]["luma"]


def test_cook_histogram_is_of_the_input_even_when_the_modifier_is_masked() -> None:
    img = _solid(40, 40, 40)
    mask = np.zeros(W * H, dtype=np.uint8).tobytes()
    header = {
        "id": "m",
        "width": W,
        "height": H,
        "modifiers": [{"type": "levels", "params": {"black": 100}}],
        "masks": [{"modifierIndex": 0, "mask_bytes": W * H}],
        "histograms": [0],
    }
    response, _ = handle_cook(header, img.tobytes() + mask)
    assert response["histograms"][0]["r"][40] == W * H


def test_a_cook_that_does_not_ask_has_no_histograms_key() -> None:
    img = _solid(1, 2, 3)
    response, _ = _cook(img, [{"type": "levels", "params": {}}])
    assert "histograms" not in response


def test_asking_for_an_op_without_a_histogram_is_refused() -> None:
    response, payload = _cook(
        _solid(1, 2, 3), [{"type": "invert", "params": {}}], histograms=[0]
    )
    assert response["ok"] is False
    assert "invert" in response["error"]
    assert payload == b""


def test_asking_for_an_index_out_of_range_is_refused() -> None:
    response, _ = _cook(
        _solid(1, 2, 3), [{"type": "levels", "params": {}}], histograms=[3]
    )
    assert response["ok"] is False


def test_histograms_do_not_change_the_picture() -> None:
    img = np.random.default_rng(5).integers(0, 256, (H, W, 4), dtype=np.uint8)
    mods = [{"type": "levels", "params": {"gamma": 1.7, "black": 12}}]
    _, with_hist = _cook(img, mods, histograms=[0])
    _, without = _cook(img, mods)
    assert with_hist == without


@pytest.mark.parametrize(
    "bad",
    [
        {"widget": "curve"},  # curve widget with no ends named
        {"widget": "curve", "curve": {"black": "lo"}},  # a role missing
        {"widget": "curve", "curve": {"black": "lo", "white": "g"}},  # names itself
        {"widget": "curve", "curve": {"black": "lo", "white": "nope"}},  # unknown param
        {"widget": "curve", "curve": {"black": "lo", "white": "flag"}},  # not a float
        {"curve": {"black": "lo", "white": "hi"}},  # ends without the widget
    ],
)
def test_a_curve_param_must_name_two_bounded_float_siblings(bad: dict) -> None:
    params = [
        P("lo", "float", min=0.0, max=1.0, default=0.0),
        P("hi", "float", min=0.0, max=1.0, default=1.0),
        P("flag", "bool", default=False),
        P("g", "float", min=0.1, max=5.0, default=1.0, **bad),
    ]
    with pytest.raises(ValueError, match="curve"):
        op("curve_bad_test", params)(lambda img, p: img)
    assert "curve_bad_test" not in OPS
