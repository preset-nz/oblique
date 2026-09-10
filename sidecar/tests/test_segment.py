"""`segment` handler tests. CI has no weights and no network, so every test
here monkeypatches `ensure_weights` and `run_segment` at the handler's own
import site — the ONNX session and the model files are never touched.
`test_fetch.py`-style checksum-mismatch coverage for `ml.fetch` lives at
the bottom of this file too (it needs a fake downloader for the same
network-free reason).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

import handlers.segment as segment_module
from handlers.segment import COARSE_MASK_BYTES, handle_segment
from ml import fetch
from ml.trace import trace_mask


def _rgba_payload(h: int, w: int, seed: int = 0) -> bytes:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8).tobytes()


def _fake_weights(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        segment_module,
        "ensure_weights",
        lambda model_dir: (
            Path(model_dir) / "encoder.onnx",
            Path(model_dir) / "decoder.onnx",
        ),
    )


def _fake_mask(h: int, w: int) -> np.ndarray:
    mask = np.zeros((h, w), dtype=bool)
    mask[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4] = True
    return mask


def test_segment_success_returns_mask_and_polygons(monkeypatch: pytest.MonkeyPatch):
    w, h = 40, 32
    _fake_weights(monkeypatch)
    known_mask = _fake_mask(h, w)
    monkeypatch.setattr(segment_module, "run_segment", lambda **kwargs: known_mask)

    header = {
        "id": "seg-1",
        "op": "segment",
        "width": w,
        "height": h,
        "model_dir": "/fake/models",
        "prompt": {
            "points": [{"x": 10, "y": 10, "label": 1}],
            "box": None,
            "mask": False,
        },
    }
    payload = _rgba_payload(h, w)

    response_header, response_payload = handle_segment(header, payload)

    assert response_header["id"] == "seg-1"
    assert response_header["ok"] is True
    assert response_header["width"] == w
    assert response_header["height"] == h
    expected_polygons = [
        [{"x": x, "y": y} for x, y in polygon]
        for polygon in trace_mask(known_mask, keep_holes=False)
    ]
    assert response_header["polygons"] == expected_polygons
    assert response_payload == (known_mask.astype(np.uint8) * 255).tobytes()


def test_segment_passes_prompt_through_to_run_segment(monkeypatch: pytest.MonkeyPatch):
    w, h = 20, 16
    _fake_weights(monkeypatch)
    captured: dict = {}

    def fake_run_segment(**kwargs):
        captured.update(kwargs)
        return _fake_mask(h, w)

    monkeypatch.setattr(segment_module, "run_segment", fake_run_segment)

    prompt = {
        "points": [{"x": 5, "y": 5, "label": 1}],
        "box": {"x0": 1, "y0": 1, "x1": 10, "y1": 10},
    }
    header = {
        "id": "seg-2",
        "op": "segment",
        "width": w,
        "height": h,
        "model_dir": "/fake/models",
        "prompt": prompt,
    }
    payload = _rgba_payload(h, w)

    response_header, _ = handle_segment(header, payload)

    assert response_header["ok"] is True
    assert captured["prompt"] == prompt
    assert captured["coarse_mask"] is None
    assert captured["rgba"].shape == (h, w, 4)


def test_segment_decodes_appended_coarse_mask(monkeypatch: pytest.MonkeyPatch):
    w, h = 20, 16
    _fake_weights(monkeypatch)
    captured: dict = {}

    def fake_run_segment(**kwargs):
        captured.update(kwargs)
        return _fake_mask(h, w)

    monkeypatch.setattr(segment_module, "run_segment", fake_run_segment)

    header = {
        "id": "seg-3",
        "op": "segment",
        "width": w,
        "height": h,
        "model_dir": "/fake/models",
        "prompt": {"points": [], "box": None, "mask": True},
    }
    image_payload = _rgba_payload(h, w)
    coarse_mask = np.zeros((256, 256), dtype=np.uint8)
    coarse_mask[64:192, 64:192] = 255
    payload = image_payload + coarse_mask.tobytes()
    assert len(payload) == w * h * 4 + COARSE_MASK_BYTES

    response_header, _ = handle_segment(header, payload)

    assert response_header["ok"] is True
    np.testing.assert_array_equal(captured["coarse_mask"], coarse_mask)


def test_segment_rejects_wrong_payload_size(monkeypatch: pytest.MonkeyPatch):
    _fake_weights(monkeypatch)
    called = False

    def fake_run_segment(**kwargs):
        nonlocal called
        called = True
        return _fake_mask(10, 10)

    monkeypatch.setattr(segment_module, "run_segment", fake_run_segment)

    header = {
        "id": "seg-4",
        "op": "segment",
        "width": 10,
        "height": 10,
        "model_dir": "/fake/models",
        "prompt": {},
    }

    response_header, response_payload = handle_segment(header, b"too short")

    assert response_header["ok"] is False
    assert "payload" in response_header["error"]
    assert response_payload == b""
    assert called is False


def test_segment_requires_model_dir(monkeypatch: pytest.MonkeyPatch):
    header = {
        "id": "seg-5",
        "op": "segment",
        "width": 10,
        "height": 10,
        "prompt": {},
    }
    response_header, response_payload = handle_segment(header, _rgba_payload(10, 10))

    assert response_header["ok"] is False
    assert "model_dir" in response_header["error"]
    assert response_payload == b""


def test_segment_surfaces_weight_fetch_failure(monkeypatch: pytest.MonkeyPatch):
    def boom(model_dir):
        raise RuntimeError("checksum mismatch")

    monkeypatch.setattr(segment_module, "ensure_weights", boom)

    header = {
        "id": "seg-6",
        "op": "segment",
        "width": 10,
        "height": 10,
        "model_dir": "/fake/models",
        "prompt": {},
    }
    response_header, response_payload = handle_segment(header, _rgba_payload(10, 10))

    assert response_header["ok"] is False
    assert "checksum mismatch" in response_header["error"]
    assert response_payload == b""


def test_segment_surfaces_inference_failure(monkeypatch: pytest.MonkeyPatch):
    _fake_weights(monkeypatch)

    def boom(**kwargs):
        raise ValueError("bad prompt")

    monkeypatch.setattr(segment_module, "run_segment", boom)

    header = {
        "id": "seg-7",
        "op": "segment",
        "width": 10,
        "height": 10,
        "model_dir": "/fake/models",
        "prompt": {},
    }
    response_header, response_payload = handle_segment(header, _rgba_payload(10, 10))

    assert response_header["ok"] is False
    assert "bad prompt" in response_header["error"]
    assert response_payload == b""


# --- ml.fetch: checksum verification, no network -----------------------


def test_ensure_weights_downloads_missing_files_and_verifies(tmp_path: Path):
    written: list[tuple[str, Path]] = []

    def fake_downloader(url: str, dest: Path) -> None:
        written.append((url, dest))
        # Write bytes that hash to the pinned constants by monkeypatching
        # the expected hashes instead — simpler and just as faithful to
        # "verify what got downloaded", see next test for the real pins.
        dest.write_bytes(b"encoder" if "encoder" in url else b"decoder")

    # Patch the pinned hashes to match our fake payloads so this test
    # doesn't depend on the real (large) model files.
    import hashlib

    encoder_sha = hashlib.sha256(b"encoder").hexdigest()
    decoder_sha = hashlib.sha256(b"decoder").hexdigest()

    orig_encoder_sha, orig_decoder_sha = fetch.ENCODER_SHA256, fetch.DECODER_SHA256
    fetch.ENCODER_SHA256 = encoder_sha
    fetch.DECODER_SHA256 = decoder_sha
    try:
        encoder_path, decoder_path = fetch.ensure_weights(
            tmp_path, downloader=fake_downloader
        )
    finally:
        fetch.ENCODER_SHA256 = orig_encoder_sha
        fetch.DECODER_SHA256 = orig_decoder_sha

    assert encoder_path.read_bytes() == b"encoder"
    assert decoder_path.read_bytes() == b"decoder"
    assert len(written) == 2

    # Second call: files already present and valid, no download needed.
    def fail_downloader(url: str, dest: Path) -> None:
        raise AssertionError("should not re-download a valid file")

    fetch.ENCODER_SHA256 = encoder_sha
    fetch.DECODER_SHA256 = decoder_sha
    try:
        fetch.ensure_weights(tmp_path, downloader=fail_downloader)
    finally:
        fetch.ENCODER_SHA256 = orig_encoder_sha
        fetch.DECODER_SHA256 = orig_decoder_sha


def test_ensure_weights_refuses_and_deletes_a_checksum_mismatch(tmp_path: Path):
    def fake_downloader(url: str, dest: Path) -> None:
        dest.write_bytes(b"not the right bytes at all")

    with pytest.raises(RuntimeError, match="checksum verification"):
        fetch.ensure_weights(tmp_path, downloader=fake_downloader)

    # The bad file must not be left behind for a future ensure_weights call
    # to wrongly accept.
    target = tmp_path / fetch.MODEL_SUBDIR / fetch.ENCODER_FILENAME
    assert not target.exists()
    part = target.with_name(target.name + ".part")
    assert not part.exists()


def test_ensure_weights_refuses_a_corrupted_existing_file_and_allows_retry(
    tmp_path: Path,
):
    target_dir = tmp_path / fetch.MODEL_SUBDIR
    target_dir.mkdir(parents=True)
    encoder_path = target_dir / fetch.ENCODER_FILENAME
    encoder_path.write_bytes(b"corrupted on disk")

    calls: list[str] = []

    def fake_downloader(url: str, dest: Path) -> None:
        calls.append(url)
        dest.write_bytes(b"encoder" if "encoder" in url else b"decoder")

    import hashlib

    orig_encoder_sha, orig_decoder_sha = fetch.ENCODER_SHA256, fetch.DECODER_SHA256
    fetch.ENCODER_SHA256 = hashlib.sha256(b"encoder").hexdigest()
    fetch.DECODER_SHA256 = hashlib.sha256(b"decoder").hexdigest()
    try:
        with pytest.raises(RuntimeError, match="checksum verification"):
            fetch.ensure_weights(tmp_path, downloader=fake_downloader)
        assert not encoder_path.exists()  # bad file deleted, not silently reused

        # Retry: no corrupted file in the way now, download proceeds and succeeds.
        encoder_path2, decoder_path2 = fetch.ensure_weights(
            tmp_path, downloader=fake_downloader
        )
        assert encoder_path2.read_bytes() == b"encoder"
        assert decoder_path2.read_bytes() == b"decoder"
    finally:
        fetch.ENCODER_SHA256 = orig_encoder_sha
        fetch.DECODER_SHA256 = orig_decoder_sha
