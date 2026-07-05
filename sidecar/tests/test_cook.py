"""`cook` handler tests: full five-op stack through the handler function,
unknown-op rejection with no partial results, and a perf smoke test.
"""

from __future__ import annotations

import time

import numpy as np
import pytest

from handlers.cook import handle_cook


def _rgba_payload(h: int, w: int, seed: int = 0) -> bytes:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8).tobytes()


def test_cook_full_five_op_stack_round_trips():
    w, h = 16, 12
    payload = _rgba_payload(h, w)

    header = {
        "id": "cook-1",
        "op": "cook",
        "width": w,
        "height": h,
        "modifiers": [
            {"type": "gaussian_blur", "params": {"radius": 2.0}},
            {"type": "levels", "params": {"black": 10.0, "white": 240.0, "gamma": 1.1}},
            {"type": "threshold", "params": {"level": 127.0, "smooth": 16.0}},
            {"type": "invert", "params": {}},
            {"type": "grain", "params": {"amount": 0.2, "size": 2, "seed": 5}},
        ],
    }

    response_header, response_payload = handle_cook(header, payload)

    timings = response_header.pop("timings_ms")
    assert [t["type"] for t in timings] == [m["type"] for m in header["modifiers"]]
    assert all(t["ms"] >= 0 for t in timings)
    assert response_header == {"id": "cook-1", "ok": True, "width": w, "height": h}
    assert len(response_payload) == w * h * 4

    result = np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w, 4)
    assert result.dtype == np.uint8
    assert result.shape == (h, w, 4)


def test_cook_folds_left_to_right():
    """invert then invert again should be identity — order matters."""
    w, h = 8, 6
    payload = _rgba_payload(h, w, seed=1)

    header = {
        "id": "cook-2",
        "op": "cook",
        "width": w,
        "height": h,
        "modifiers": [
            {"type": "invert", "params": {}},
            {"type": "invert", "params": {}},
        ],
    }

    _response_header, response_payload = handle_cook(header, payload)

    np.testing.assert_array_equal(
        np.frombuffer(response_payload, dtype=np.uint8),
        np.frombuffer(payload, dtype=np.uint8),
    )


def test_cook_unknown_op_returns_ok_false_with_no_partial_result():
    w, h = 4, 4
    payload = _rgba_payload(h, w, seed=2)

    header = {
        "id": "cook-3",
        "op": "cook",
        "width": w,
        "height": h,
        "modifiers": [
            {"type": "invert", "params": {}},
            {"type": "frobnicate", "params": {}},
        ],
    }

    response_header, response_payload = handle_cook(header, payload)

    assert response_header == {
        "id": "cook-3",
        "ok": False,
        "error": "unknown op 'frobnicate'",
    }
    assert response_payload == b""


def test_cook_empty_modifier_list_returns_payload_unchanged():
    w, h = 5, 3
    payload = _rgba_payload(h, w, seed=3)

    header = {"id": "cook-4", "op": "cook", "width": w, "height": h, "modifiers": []}

    response_header, response_payload = handle_cook(header, payload)

    assert response_header["ok"] is True
    assert response_payload == payload


def test_cook_rejects_mismatched_payload_size():
    header = {"id": "cook-5", "op": "cook", "width": 10, "height": 10, "modifiers": []}

    response_header, response_payload = handle_cook(header, b"too short")

    assert response_header["ok"] is False
    assert response_payload == b""


def _masked_header(w: int, h: int, request_id: str = "cook-mask") -> dict:
    return {
        "id": request_id,
        "op": "cook",
        "width": w,
        "height": h,
        "modifiers": [{"type": "invert", "params": {}}],
        "masks": [{"modifierIndex": 0, "mask_bytes": w * h}],
    }


def test_cook_masked_invert_blends_only_inside_mask():
    """Half-plane mask on invert: left half inverted, right half untouched."""
    w, h = 8, 6
    payload = _rgba_payload(h, w, seed=7)
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[:, : w // 2] = 255

    response_header, response_payload = handle_cook(
        _masked_header(w, h), payload + mask.tobytes()
    )

    assert response_header["ok"] is True
    assert len(response_payload) == w * h * 4
    original = np.frombuffer(payload, dtype=np.uint8).reshape(h, w, 4)
    result = np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w, 4)
    left, right = result[:, : w // 2], result[:, w // 2 :]
    np.testing.assert_array_equal(left[..., :3], 255 - original[:, : w // 2, :3])
    np.testing.assert_array_equal(left[..., 3], original[:, : w // 2, 3])
    np.testing.assert_array_equal(right, original[:, w // 2 :])


def test_cook_mask_value_128_is_a_feathered_50_50_blend():
    """A uniform 128 mask blends op output and input at 128/255 weight."""
    w, h = 4, 4
    payload = _rgba_payload(h, w, seed=8)
    mask = np.full((h, w), 128, dtype=np.uint8)

    _response_header, response_payload = handle_cook(
        _masked_header(w, h), payload + mask.tobytes()
    )

    original = np.frombuffer(payload, dtype=np.uint8).reshape(h, w, 4)
    inverted = original.copy()
    inverted[..., :3] = 255 - inverted[..., :3]
    weight = 128.0 / 255.0
    expected = np.clip(
        np.rint(
            weight * inverted.astype(np.float32)
            + (1.0 - weight) * original.astype(np.float32)
        ),
        0,
        255,
    ).astype(np.uint8)
    np.testing.assert_array_equal(
        np.frombuffer(response_payload, dtype=np.uint8).reshape(h, w, 4), expected
    )


def test_cook_empty_masks_array_matches_omitted_masks_byte_for_byte():
    w, h = 6, 5
    payload = _rgba_payload(h, w, seed=9)
    base = {
        "id": "cook-nomask",
        "op": "cook",
        "width": w,
        "height": h,
        "modifiers": [{"type": "invert", "params": {}}],
    }

    _h1, without_key = handle_cook(base, payload)
    _h2, with_empty = handle_cook({**base, "masks": []}, payload)

    assert without_key == with_empty


def test_cook_rejects_mask_modifier_index_out_of_range():
    w, h = 4, 4
    payload = _rgba_payload(h, w, seed=10)
    mask = np.zeros((h, w), dtype=np.uint8)
    header = _masked_header(w, h)
    header["masks"] = [{"modifierIndex": 1, "mask_bytes": w * h}]

    response_header, response_payload = handle_cook(header, payload + mask.tobytes())

    assert response_header["ok"] is False
    assert "modifierIndex" in response_header["error"]
    assert response_payload == b""


def test_cook_rejects_wrong_mask_bytes():
    w, h = 4, 4
    payload = _rgba_payload(h, w, seed=11)
    mask = np.zeros((h, w), dtype=np.uint8)
    header = _masked_header(w, h)
    header["masks"][0]["mask_bytes"] = w * h - 1

    response_header, response_payload = handle_cook(header, payload + mask.tobytes())

    assert response_header["ok"] is False
    assert "must be" in response_header["error"]
    assert response_payload == b""


def test_cook_rejects_payload_missing_declared_mask_plane():
    w, h = 4, 4
    payload = _rgba_payload(h, w, seed=12)

    # Header declares one mask, payload carries the image only.
    response_header, response_payload = handle_cook(_masked_header(w, h), payload)

    assert response_header["ok"] is False
    assert "payload bytes" in response_header["error"]
    assert response_payload == b""


@pytest.mark.perf
def test_cook_512x512_five_op_stack_under_50ms():
    """WORKING-scale perf smoke test (story acceptance).

    Marked so it doesn't gate CI on shared/loaded runners' wall-clock
    variance; run explicitly with `-m perf`. Measured on this dev machine:
    see test output for the actual timing printed on failure.
    """
    w, h = 512, 512
    payload = _rgba_payload(h, w, seed=42)

    header = {
        "id": "cook-perf",
        "op": "cook",
        "width": w,
        "height": h,
        "modifiers": [
            {"type": "gaussian_blur", "params": {"radius": 4.0}},
            {"type": "levels", "params": {"black": 0.0, "white": 255.0, "gamma": 1.0}},
            {"type": "threshold", "params": {"level": 127.0, "smooth": 8.0}},
            {"type": "invert", "params": {}},
            {"type": "grain", "params": {"amount": 0.1, "size": 2, "seed": 1}},
        ],
    }

    start = time.perf_counter()
    response_header, _response_payload = handle_cook(header, payload)
    elapsed_ms = (time.perf_counter() - start) * 1000.0

    assert response_header["ok"] is True
    assert elapsed_ms < 50.0, f"cook stack took {elapsed_ms:.2f}ms, expected < 50ms"
