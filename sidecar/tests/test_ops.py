"""Per-op unit tests: shape/dtype preservation, purity, edge params, and
grain's seeded determinism. `list_ops` completeness/backend/scale coverage
lives here too (dispatch-level list_ops behaviour is in test_dispatch.py).
"""

from __future__ import annotations

import numpy as np
import pytest

from main import dispatch
from ops import OPS, ParamSpec, default_label, hex_to_rgb01, op
from ops.cmyk_halftone import cmyk_halftone
from ops.gaussian_blur import gaussian_blur
from ops.grain import grain
from ops.invert import invert
from ops.levels import levels
from ops.threshold import threshold

ALL_OPS = [
    (gaussian_blur, {"radius": 4.0}),
    (levels, {"black": 10.0, "white": 240.0, "gamma": 1.2}),
    (threshold, {"level": 127.0, "smooth": 8.0}),
    (invert, {}),
    (grain, {"amount": 0.3, "size": 2, "seed": 7}),
    (cmyk_halftone, {"dot_size": 3.0, "misregistration": 1.0, "seed": 7}),
    (
        cmyk_halftone,
        {"dot_size": 3.0, "white_is_alpha": True, "spill": True, "seed": 7},
    ),
]


def _random_rgba(rng: np.random.Generator, h: int = 12, w: int = 16) -> np.ndarray:
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


def test_gaussian_blur_edge_radii_do_not_throw():
    rng = np.random.default_rng(2)
    img = _random_rgba(rng)

    zero = gaussian_blur(img, {"radius": 0.0})
    np.testing.assert_array_equal(zero, img)

    huge = gaussian_blur(img, {"radius": 100.0})
    assert huge.shape == img.shape


def test_gaussian_blur_alpha_untouched():
    rng = np.random.default_rng(3)
    img = _random_rgba(rng)

    out = gaussian_blur(img, {"radius": 5.0})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_levels_clamps_white_at_or_below_black():
    rng = np.random.default_rng(4)
    img = _random_rgba(rng)

    out = levels(img, {"black": 200.0, "white": 50.0, "gamma": 1.0})

    assert out.shape == img.shape
    assert out.dtype == np.uint8


def test_levels_extreme_gamma_does_not_throw():
    rng = np.random.default_rng(5)
    img = _random_rgba(rng)

    low_gamma = levels(img, {"black": 0.0, "white": 255.0, "gamma": 0.1})
    high_gamma = levels(img, {"black": 0.0, "white": 255.0, "gamma": 5.0})

    assert low_gamma.dtype == np.uint8
    assert high_gamma.dtype == np.uint8


def test_levels_alpha_untouched():
    rng = np.random.default_rng(6)
    img = _random_rgba(rng)

    out = levels(img, {"black": 10.0, "white": 200.0, "gamma": 2.0})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_threshold_hard_step_extremes():
    img = np.zeros((4, 4, 4), dtype=np.uint8)
    img[..., :3] = 200  # bright
    img[..., 3] = 255

    black_level = threshold(img, {"level": 0.0, "smooth": 0.0})
    white_level = threshold(img, {"level": 255.0, "smooth": 0.0})

    assert np.all(black_level[..., :3] == 255)
    assert np.all(white_level[..., :3] == 0)


def test_threshold_smoothstep_does_not_throw_at_max_smooth():
    rng = np.random.default_rng(7)
    img = _random_rgba(rng)

    out = threshold(img, {"level": 127.0, "smooth": 64.0})

    assert out.dtype == np.uint8


def test_threshold_alpha_untouched_and_rgb_grey():
    rng = np.random.default_rng(8)
    img = _random_rgba(rng)

    out = threshold(img, {"level": 100.0, "smooth": 10.0})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])
    assert np.all(out[..., 0] == out[..., 1])
    assert np.all(out[..., 1] == out[..., 2])


def test_invert_is_255_minus_rgb():
    rng = np.random.default_rng(9)
    img = _random_rgba(rng)

    out = invert(img, {})

    np.testing.assert_array_equal(out[..., :3], 255 - img[..., :3])
    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_grain_seed_determinism():
    rng = np.random.default_rng(10)
    img = _random_rgba(rng, h=20, w=24)
    params = {"amount": 0.5, "size": 3, "seed": 42}

    first = grain(img, params)
    second = grain(img, params)

    np.testing.assert_array_equal(first, second)


def test_grain_different_seed_differs():
    rng = np.random.default_rng(11)
    img = _random_rgba(rng, h=20, w=24)

    a = grain(img, {"amount": 0.5, "size": 1, "seed": 1})
    b = grain(img, {"amount": 0.5, "size": 1, "seed": 2})

    assert not np.array_equal(a, b)


def test_grain_respects_alpha():
    rng = np.random.default_rng(13)
    img = _random_rgba(rng, h=16, w=16)
    img[:8, :, 3] = 0  # top half fully transparent
    img[8:, :, 3] = 255  # bottom half fully opaque

    out = grain(img, {"amount": 1.0, "size": 1, "seed": 5})

    # Transparent pixels: RGB byte-identical, no grain lands there.
    np.testing.assert_array_equal(out[:8, :, :3], img[:8, :, :3])
    # Opaque pixels: grain applied.
    assert not np.array_equal(out[8:, :, :3], img[8:, :, :3])
    # Alpha itself always passes through untouched.
    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_grain_edge_params_do_not_throw():
    rng = np.random.default_rng(12)
    img = _random_rgba(rng)

    zero_amount = grain(img, {"amount": 0.0, "size": 1, "seed": 0})
    np.testing.assert_array_equal(zero_amount, img)

    max_amount_max_size = grain(img, {"amount": 1.0, "size": 8, "seed": 0})
    assert max_amount_max_size.shape == img.shape


def test_grain_alpha_untouched():
    rng = np.random.default_rng(13)
    img = _random_rgba(rng)

    out = grain(img, {"amount": 0.4, "size": 2, "seed": 3})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_list_ops_includes_all_five_with_honest_specs():
    header, _payload = dispatch({"id": "list", "op": "list_ops"}, b"")

    names = {o["name"] for o in header["ops"]}
    for expected in ("gaussian_blur", "levels", "threshold", "invert", "grain"):
        assert expected in names

    for entry in header["ops"]:
        if entry["name"] not in {
            "gaussian_blur",
            "levels",
            "threshold",
            "invert",
            "grain",
        }:
            continue
        assert entry["backend"] == "python"
        for param in entry["params"]:
            assert "scale" in param
            assert param["scale"] in ("spatial", "none")

    blur = next(o for o in header["ops"] if o["name"] == "gaussian_blur")
    radius_param = next(p for p in blur["params"] if p["name"] == "radius")
    assert radius_param["scale"] == "spatial"

    grain_entry = next(o for o in header["ops"] if o["name"] == "grain")
    size_param = next(p for p in grain_entry["params"] if p["name"] == "size")
    assert size_param["scale"] == "spatial"
    amount_param = next(p for p in grain_entry["params"] if p["name"] == "amount")
    assert amount_param["scale"] == "none"


def test_all_five_ops_registered_in_ops_registry():
    for name in ("gaussian_blur", "levels", "threshold", "invert", "grain"):
        assert name in OPS
        assert OPS[name].backend == "python"


def test_cmyk_halftone_seed_determinism():
    rng = np.random.default_rng(8)
    img = _random_rgba(rng, h=32, w=32)
    params = {"dot_size": 4.0, "misregistration": 2.0, "seed": 42}

    np.testing.assert_array_equal(
        cmyk_halftone(img, params), cmyk_halftone(img, params)
    )


def test_cmyk_halftone_mid_grey_shows_dot_structure():
    # Spec acceptance: mid-grey input yields visible screen structure —
    # both inked and paper pixels must exist.
    img = np.full((64, 64, 4), 128, dtype=np.uint8)
    img[..., 3] = 255

    out = cmyk_halftone(img, {"dot_size": 6.0, "mode": "paper"})
    lum = out[..., :3].mean(axis=-1)

    assert (lum < 100).any(), "expected inked dots"
    assert (lum > 200).any(), "expected paper between dots"


def test_cmyk_halftone_solid_primary_mostly_single_channel():
    # Pure red -> cyan plate ~0; red channel should stay high where
    # magenta/yellow dots land (they don't absorb red).
    img = np.zeros((64, 64, 4), dtype=np.uint8)
    img[..., 0] = 255
    img[..., 3] = 255

    out = cmyk_halftone(img, {"dot_size": 6.0, "mode": "paper"})

    assert out[..., 0].mean() > 200, (
        "cyan/black plates should be near-empty on pure red"
    )


def test_cmyk_halftone_alpha_untouched():
    rng = np.random.default_rng(9)
    img = _random_rgba(rng, h=24, w=24)

    out = cmyk_halftone(img, {"dot_size": 4.0})

    np.testing.assert_array_equal(out[..., 3], img[..., 3])


def test_cmyk_halftone_over_mode_darkens_input():
    rng = np.random.default_rng(10)
    img = _random_rgba(rng, h=24, w=24)

    out = cmyk_halftone(img, {"dot_size": 4.0, "mode": "over"})

    assert (out[..., :3].astype(int) <= img[..., :3].astype(int)).all()


def test_default_label_title_cases_snake_case_names():
    assert default_label("gaussian_blur") == "Gaussian Blur"
    assert default_label("invert") == "Invert"
    assert default_label("colour_crush") == "Colour Crush"


def test_default_label_upper_cases_known_acronyms():
    assert default_label("cmyk_halftone") == "CMYK Halftone"
    assert default_label("dla") == "DLA"
    assert default_label("dla_growth") == "DLA Growth"


def test_every_registered_non_debug_op_has_a_description():
    for name, entry in OPS.items():
        if name.startswith("debug_"):
            continue
        assert entry.description, f"{name} is missing a user-facing description"


def test_op_to_dict_includes_label_and_description():
    xerox_entry = OPS["xerox"].to_dict()
    assert xerox_entry["label"] == "Xerox"
    assert "description" in xerox_entry
    assert xerox_entry["description"]


def test_op_to_dict_derives_label_when_not_supplied():
    @op("temp_test_op_for_label_fallback")
    def _temp(img, params):  # noqa: ANN001, ARG001
        return img

    try:
        entry = OPS["temp_test_op_for_label_fallback"].to_dict()
        assert entry["label"] == "Temp Test Op For Label Fallback"
        assert "description" not in entry
    finally:
        del OPS["temp_test_op_for_label_fallback"]


# --- color param kind (Epic 15 story 1) --------------------------------


def test_color_param_spec_to_dict_is_exactly_name_type_default_scale():
    spec = ParamSpec("ink", "color", default="#00ffff")
    assert spec.to_dict() == {
        "name": "ink",
        "type": "color",
        "default": "#00ffff",
        "scale": "none",
    }


# --- param label + description (Epic 04, param-labels story) ------------


def test_param_spec_to_dict_emits_label_and_description_only_when_set():
    bare = ParamSpec("cell_size", "int", default=8).to_dict()
    assert "label" not in bare
    assert "description" not in bare

    annotated = ParamSpec(
        "cell_size",
        "int",
        default=8,
        label="Cell size",
        description="Size of each mosaic cell in document pixels.",
    ).to_dict()
    assert annotated["label"] == "Cell size"
    assert annotated["description"] == "Size of each mosaic cell in document pixels."


def test_list_ops_round_trips_param_label_and_description():
    header, _payload = dispatch({"id": "list", "op": "list_ops"}, b"")

    pixelate = next(o for o in header["ops"] if o["name"] == "pixelate")
    cell_size = next(p for p in pixelate["params"] if p["name"] == "cell_size")
    assert cell_size["label"] == OPS["pixelate"].params[0].label == "Cell size"
    assert cell_size["description"] == OPS["pixelate"].params[0].description


def test_every_registered_param_has_a_label_and_description():
    # Guard: a new op (or param) cannot ship without presentation metadata.
    # `debug_echo` has no params, so it passes vacuously.
    missing = [
        f"{name}.{param.name}"
        for name, entry in OPS.items()
        if not name.startswith("temp_test_")
        for param in entry.params
        if not (param.label and param.label.strip())
        or not (param.description and param.description.strip())
    ]
    assert missing == []


@pytest.mark.parametrize(
    "value,expected",
    [
        ("#00ffff", (0.0, 1.0, 1.0)),
        ("#0FF", (0.0, 1.0, 1.0)),
        ("00ffff", (0.0, 1.0, 1.0)),
        ("  #00FFFF  ", (0.0, 1.0, 1.0)),
    ],
)
def test_hex_to_rgb01_parses_valid_hex(value, expected):
    assert hex_to_rgb01(value, fallback=(0.0, 0.0, 0.0)) == expected


@pytest.mark.parametrize(
    "value",
    [
        None,
        42,
        "puce",
        "#12345",
        "#gggggg",
        "#00ffffff",
        # int(x, 16) alone accepts a leading sign/underscore — these are
        # each 6 chars, so the length check alone wouldn't catch them.
        "-1-2-3",
        "+1+2+3",
    ],
)
def test_hex_to_rgb01_falls_back_and_never_raises(value):
    fallback = (0.5, 0.25, 0.75)
    assert hex_to_rgb01(value, fallback=fallback) == fallback


# --- disabled_when contract (Epic 18 story 5) ------------------------------


def test_no_other_registered_op_emits_disabled_when():
    # `hatch` is disabled_when's first user (story 5 doc). Every other op's
    # list_ops payload must stay byte-identical. `cmyk_halftone.spill` is
    # the one other annotated param (2026-10-01); `colour_keep` greys its
    # second band while `use_keep_2` is off.
    annotated = {
        ("cmyk_halftone", "spill"),
        ("colour_keep", "keep_2"),
        ("colour_keep", "hue_range_2"),
    }
    for name, entry in OPS.items():
        if name == "hatch":
            continue
        for param in entry.to_dict()["params"]:
            if (name, param["name"]) in annotated:
                continue
            assert "disabledWhen" not in param, (
                f"{name}.{param['name']} unexpectedly carries disabledWhen"
            )


def test_disabled_when_path_must_name_another_param_of_the_same_op():
    with pytest.raises(ValueError, match="disabled_when path"):

        @op(
            "temp_test_disabled_when_unknown_path",
            [
                ParamSpec("pattern", "enum", default="a", choices=("a", "b")),
                ParamSpec(
                    "pen",
                    "float",
                    default=1.0,
                    disabled_when={"path": "does_not_exist", "equals": "a"},
                ),
            ],
        )
        def _temp(img, params):  # noqa: ANN001, ARG001
            return img

    assert "temp_test_disabled_when_unknown_path" not in OPS


def test_disabled_when_path_cannot_name_itself():
    with pytest.raises(ValueError, match="disabled_when path"):

        @op(
            "temp_test_disabled_when_self_path",
            [
                ParamSpec(
                    "pen",
                    "float",
                    default=1.0,
                    disabled_when={"path": "pen", "equals": 1.0},
                ),
            ],
        )
        def _temp(img, params):  # noqa: ANN001, ARG001
            return img

    assert "temp_test_disabled_when_self_path" not in OPS


def test_disabled_when_requires_exactly_one_operator():
    with pytest.raises(ValueError, match="exactly one of"):

        @op(
            "temp_test_disabled_when_two_operators",
            [
                ParamSpec("pattern", "enum", default="a", choices=("a", "b")),
                ParamSpec(
                    "pen",
                    "float",
                    default=1.0,
                    disabled_when={
                        "path": "pattern",
                        "equals": "a",
                        "notEquals": "b",
                    },
                ),
            ],
        )
        def _temp(img, params):  # noqa: ANN001, ARG001
            return img

    assert "temp_test_disabled_when_two_operators" not in OPS


def test_disabled_when_requires_at_least_one_operator():
    with pytest.raises(ValueError, match="exactly one of"):

        @op(
            "temp_test_disabled_when_no_operator",
            [
                ParamSpec("pattern", "enum", default="a", choices=("a", "b")),
                ParamSpec(
                    "pen",
                    "float",
                    default=1.0,
                    disabled_when={"path": "pattern"},
                ),
            ],
        )
        def _temp(img, params):  # noqa: ANN001, ARG001
            return img

    assert "temp_test_disabled_when_no_operator" not in OPS


def test_disabled_when_rejects_unknown_operator_key():
    with pytest.raises(ValueError, match="unknown key"):

        @op(
            "temp_test_disabled_when_unknown_key",
            [
                ParamSpec("pattern", "enum", default="a", choices=("a", "b")),
                ParamSpec(
                    "pen",
                    "float",
                    default=1.0,
                    disabled_when={"path": "pattern", "greaterThan": "a"},
                ),
            ],
        )
        def _temp(img, params):  # noqa: ANN001, ARG001
            return img

    assert "temp_test_disabled_when_unknown_key" not in OPS


@pytest.mark.parametrize(
    "case,operand",
    [("empty_tuple", ()), ("scalar", "a")],
)
def test_disabled_when_in_must_be_a_non_empty_list_or_tuple(case, operand):
    op_name = f"temp_test_disabled_when_bad_in_{case}"

    with pytest.raises(ValueError, match="non-empty list/tuple"):

        @op(
            op_name,
            [
                ParamSpec("pattern", "enum", default="a", choices=("a", "b")),
                ParamSpec(
                    "seed",
                    "int",
                    default=0,
                    disabled_when={"path": "pattern", "in": operand},
                ),
            ],
        )
        def _temp(img, params):  # noqa: ANN001, ARG001
            return img

    assert op_name not in OPS


def test_disabled_when_enum_value_must_be_a_valid_choice():
    # Catches `"cross"` vs `"crosses"` — a typo'd operand fails at import,
    # not silently in the UI.
    with pytest.raises(ValueError, match="not in its choices"):

        @op(
            "temp_test_disabled_when_bad_enum_value",
            [
                ParamSpec(
                    "pattern",
                    "enum",
                    default="lines",
                    choices=("lines", "dashes", "crosses", "stipple"),
                ),
                ParamSpec(
                    "cross_size",
                    "float",
                    default=1.0,
                    disabled_when={"path": "pattern", "equals": "cross"},
                ),
            ],
        )
        def _temp(img, params):  # noqa: ANN001, ARG001
            return img

    assert "temp_test_disabled_when_bad_enum_value" not in OPS


def test_disabled_when_valid_registration_round_trips_through_to_dict():
    @op(
        "temp_test_disabled_when_valid",
        [
            ParamSpec("pattern", "enum", default="lines", choices=("lines", "dashes")),
            ParamSpec(
                "seed",
                "int",
                default=0,
                disabled_when={"path": "pattern", "notIn": ("dashes",)},
            ),
        ],
    )
    def _temp(img, params):  # noqa: ANN001, ARG001
        return img

    try:
        assert "temp_test_disabled_when_valid" in OPS
        entry = OPS["temp_test_disabled_when_valid"].to_dict()
        seed_param = next(p for p in entry["params"] if p["name"] == "seed")
        assert seed_param["disabledWhen"] == {"path": "pattern", "notIn": ["dashes"]}
    finally:
        del OPS["temp_test_disabled_when_valid"]
