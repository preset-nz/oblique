"""Op categories and choice labels: registration rules and the `list_ops` wire."""

from __future__ import annotations

import pytest
from main import dispatch
from ops import CATEGORIES, CATEGORY_IDS, OPS, Op, ParamSpec, op


def _real_ops():
    # `debug_` canaries are hidden from every picker; `temp_test_` ops are
    # other tests' registration probes that stay in the registry.
    return {
        name: entry
        for name, entry in OPS.items()
        if not name.startswith(("debug_", "temp_test_"))
    }


def test_every_registered_op_has_a_known_category():
    for name, entry in _real_ops().items():
        assert entry.category, f"{name} has no category"
        assert entry.category in CATEGORY_IDS, f"{name}: {entry.category!r} unknown"


def test_every_category_has_at_least_one_op():
    used = {entry.category for entry in _real_ops().values()}
    assert used == CATEGORY_IDS


def test_categories_are_declared_in_picker_order_with_capitalised_labels():
    assert [(c.id, c.label) for c in CATEGORIES] == [
        ("colour", "Colour"),
        ("print", "Print"),
        ("film", "Film"),
        ("distort", "Distort"),
        ("edges", "Edges"),
    ]


def test_decided_assignments():
    expected = {
        "colour": "colour_crush colour_keep colourise desaturate invert levels recolour",
        "print": "cmyk_halftone hatch ink_starved threshold xerox",
        "film": "bloom film_burn film_stock grain technicolor",
        "distort": "gaussian_blur pixelate smear",
        "edges": "dilate erode edge_noise",
    }
    for category, names in expected.items():
        for name in names.split():
            assert OPS[name].category == category, name


def test_unknown_category_is_rejected_at_registration():
    with pytest.raises(ValueError, match="unknown category"):

        @op("temp_test_unknown_category", category="sparkle")
        def _temp(img, params):
            return img

    assert "temp_test_unknown_category" not in OPS


def test_category_is_absent_from_the_wire_when_unset():
    bare = Op(name="bare", backend="python", params=[], fn=lambda img, params: img)
    assert "category" not in bare.to_dict()
    assert OPS["debug_echo"].category is None
    assert "category" not in OPS["debug_echo"].to_dict()


def test_list_ops_carries_each_ops_category_and_the_ordered_category_list():
    header, _ = dispatch({"id": "1", "op": "list_ops"}, b"")
    by_name = {o["name"]: o for o in header["ops"]}
    assert by_name["gaussian_blur"]["category"] == "distort"
    assert header["categories"] == [
        {"id": "colour", "label": "Colour"},
        {"id": "print", "label": "Print"},
        {"id": "film", "label": "Film"},
        {"id": "distort", "label": "Distort"},
        {"id": "edges", "label": "Edges"},
    ]


def test_film_stock_labels_its_choices_and_keeps_the_values():
    stock = next(
        p for p in OPS["film_stock"].to_dict()["params"] if p["name"] == "stock"
    )
    assert stock["choices"] == [
        "polaroid_600",
        "sx70",
        "cross_process",
        "bleach_bypass",
        "expired",
    ]
    assert stock["choice_labels"] == {
        "polaroid_600": "Instant",
        "sx70": "Instant, Faded",
        "cross_process": "Cross Process",
        "bleach_bypass": "Bleach Bypass",
        "expired": "Expired",
    }


def test_choice_labels_are_absent_when_unset_or_empty():
    plain = ParamSpec("mode", "enum", default="a", choices=("a", "b"))
    empty = ParamSpec("mode", "enum", default="a", choices=("a", "b"), choice_labels={})
    assert "choice_labels" not in plain.to_dict()
    assert "choice_labels" not in empty.to_dict()


def test_choice_labels_must_name_existing_choices():
    with pytest.raises(ValueError, match="not in its choices"):

        @op(
            "temp_test_bad_choice_label",
            [
                ParamSpec(
                    "mode",
                    "enum",
                    default="a",
                    choices=("a", "b"),
                    choice_labels={"c": "Nope"},
                )
            ],
        )
        def _temp(img, params):
            return img

    assert "temp_test_bad_choice_label" not in OPS


def test_choice_labels_only_apply_to_enum_params():
    with pytest.raises(ValueError, match="only applies to an enum"):

        @op(
            "temp_test_choice_labels_on_float",
            [ParamSpec("amount", "float", default=1.0, choice_labels={"a": "A"})],
        )
        def _temp(img, params):
            return img

    assert "temp_test_choice_labels_on_float" not in OPS


def test_every_registered_choice_label_names_a_real_choice():
    for name, entry in OPS.items():
        for p in entry.params:
            assert set(p.choice_labels or {}) <= set(p.choices or ()), (
                f"{name}.{p.name}"
            )
