"""`select_colour` handler tests (Epic 17 story 2b, colour-range-select.md):
header/payload parsing, multi-seed positive/negative combination, and the
hole-keeping trace (`keep_holes=True`, unlike `segment`'s v1) on a flat
red-square-on-white synthetic image.
"""

from __future__ import annotations

import numpy as np
from handlers.select_colour import handle_select_colour
from ml.trace import trace_mask


def _square_on_white(h: int, w: int, y0: int, x0: int, y1: int, x1: int) -> bytes:
    img = np.full((h, w, 4), 255, dtype=np.uint8)
    img[y0:y1, x0:x1, 0] = 200
    img[y0:y1, x0:x1, 1] = 0
    img[y0:y1, x0:x1, 2] = 0
    return img.tobytes()


def test_seed_on_white_selects_white_and_the_square_is_a_hole():
    w, h = 40, 40
    payload = _square_on_white(h, w, 10, 10, 30, 30)

    header = {
        "id": "sc-1",
        "op": "select_colour",
        "width": w,
        "height": h,
        "seeds": [{"x": 0, "y": 0, "label": 1}],
        "params": {
            "tolerance": 32,
            "contiguous": True,
            "space": "lab",
            "expand": 0,
            "min_island": 16,
        },
    }

    response_header, response_payload = handle_select_colour(header, payload)

    assert response_header["ok"] is True
    assert response_header["width"] == w
    assert response_header["height"] == h
    polygons = response_header["polygons"]
    # One outer contour (the frame boundary) and one hole (the red square).
    assert len(polygons) == 2

    mask = np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w) > 0
    assert mask[0, 0]
    assert not mask[20, 20]  # inside the red square — excluded


def test_contiguous_false_on_two_same_colour_squares_selects_both():
    w, h = 40, 20
    img = np.full((h, w, 4), 255, dtype=np.uint8)
    img[2:6, 2:6, :3] = (10, 20, 30)
    img[2:6, 30:34, :3] = (10, 20, 30)
    payload = img.tobytes()

    header = {
        "id": "sc-2",
        "op": "select_colour",
        "width": w,
        "height": h,
        "seeds": [{"x": 3, "y": 3, "label": 1}],
        "params": {
            "tolerance": 0,
            "contiguous": False,
            "space": "rgb",
            "expand": 0,
            "min_island": 0,
        },
    }

    _response_header, response_payload = handle_select_colour(header, payload)

    mask = np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w) > 0
    assert mask[3, 3]
    assert mask[3, 31]


def test_negative_seed_subtracts_from_positive_union():
    w, h = 30, 10
    img = np.full((h, w, 4), 255, dtype=np.uint8)
    img[2:6, 2:6, :3] = (10, 20, 30)
    img[2:6, 20:24, :3] = (10, 20, 30)
    payload = img.tobytes()

    header = {
        "id": "sc-3",
        "op": "select_colour",
        "width": w,
        "height": h,
        "seeds": [
            {"x": 3, "y": 3, "label": 1},
            {"x": 21, "y": 3, "label": 1},
            {"x": 21, "y": 3, "label": 0},
        ],
        "params": {
            "tolerance": 0,
            "contiguous": True,
            "space": "rgb",
            "expand": 0,
            "min_island": 0,
        },
    }

    _response_header, response_payload = handle_select_colour(header, payload)

    mask = np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w) > 0
    assert mask[3, 3]
    assert not mask[3, 21]


def test_tolerance_and_contiguous_default_when_params_omitted():
    w, h = 10, 10
    payload = _square_on_white(h, w, 3, 3, 7, 7)

    header = {
        "id": "sc-4",
        "op": "select_colour",
        "width": w,
        "height": h,
        "seeds": [{"x": 0, "y": 0, "label": 1}],
    }

    response_header, response_payload = handle_select_colour(header, payload)

    assert response_header["ok"] is True
    mask = np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w) > 0
    assert mask[0, 0]


def test_missing_seeds_is_ok_false():
    header = {"id": "sc-5", "op": "select_colour", "width": 4, "height": 4, "seeds": []}
    response_header, response_payload = handle_select_colour(
        header, b"\x00" * (4 * 4 * 4)
    )
    assert response_header["ok"] is False
    assert response_payload == b""


def test_bad_payload_size_is_ok_false():
    header = {
        "id": "sc-6",
        "op": "select_colour",
        "width": 4,
        "height": 4,
        "seeds": [{"x": 0, "y": 0, "label": 1}],
    }
    response_header, _response_payload = handle_select_colour(header, b"\x00\x01\x02")
    assert response_header["ok"] is False
    assert "payload" in response_header["error"]


def test_same_request_twice_is_byte_identical():
    w, h = 24, 24
    payload = _square_on_white(h, w, 5, 5, 15, 15)
    header = {
        "id": "sc-7",
        "op": "select_colour",
        "width": w,
        "height": h,
        "seeds": [{"x": 0, "y": 0, "label": 1}],
        "params": {
            "tolerance": 32,
            "contiguous": True,
            "space": "lab",
            "expand": 1,
            "min_island": 4,
        },
    }

    header_a, payload_a = handle_select_colour(dict(header, id="sc-7a"), payload)
    header_b, payload_b = handle_select_colour(dict(header, id="sc-7b"), payload)

    assert header_a["polygons"] == header_b["polygons"]
    assert payload_a == payload_b


def test_polygons_match_trace_mask_keep_holes_true():
    w, h = 30, 30
    payload = _square_on_white(h, w, 8, 8, 20, 20)
    header = {
        "id": "sc-8",
        "op": "select_colour",
        "width": w,
        "height": h,
        "seeds": [{"x": 0, "y": 0, "label": 1}],
        "params": {
            "tolerance": 0,
            "contiguous": True,
            "space": "rgb",
            "expand": 0,
            "min_island": 0,
        },
    }

    response_header, response_payload = handle_select_colour(header, payload)
    mask = np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w) > 0
    expected_polygons = [
        [{"x": x, "y": y} for x, y in polygon]
        for polygon in trace_mask(mask, keep_holes=True)
    ]
    assert response_header["polygons"] == expected_polygons
