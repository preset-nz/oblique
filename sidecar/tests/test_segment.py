"""`segment` handler tests. CI has no weights and no network, so every test
here stands in a model folder (a `manifest.json` and stub files) and monkeypatches
`run_segment` at the handler's own import site — the ONNX session and the real
model files are never touched. Downloads are app-kit's (Rust); the sidecar only
reads the folder, which the last test pins.
"""

from __future__ import annotations

import socket
from pathlib import Path

import handlers.segment as segment_module
import numpy as np
import pytest
from handlers.segment import COARSE_MASK_BYTES, handle_segment
from ml.session import DECODER_FILENAME, ENCODER_FILENAME, MANIFEST_FILENAME
from ml.trace import trace_mask


def _rgba_payload(h: int, w: int, seed: int = 0) -> bytes:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8).tobytes()


def _install_model(model_dir: Path) -> str:
    """A model folder as app-kit leaves it: the two files, then the manifest (written last)."""
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / ENCODER_FILENAME).write_bytes(b"encoder")
    (model_dir / DECODER_FILENAME).write_bytes(b"decoder")
    (model_dir / MANIFEST_FILENAME).write_text('{"id": "mobile_sam"}')
    return str(model_dir)


def _fake_mask(h: int, w: int) -> np.ndarray:
    mask = np.zeros((h, w), dtype=bool)
    mask[h // 4 : 3 * h // 4, w // 4 : 3 * w // 4] = True
    return mask


def test_segment_success_returns_mask_and_polygons(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    w, h = 40, 32
    model_dir = _install_model(tmp_path)
    known_mask = _fake_mask(h, w)
    monkeypatch.setattr(segment_module, "run_segment", lambda **kwargs: known_mask)

    header = {
        "id": "seg-1",
        "op": "segment",
        "width": w,
        "height": h,
        "model_dir": model_dir,
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


def test_segment_passes_prompt_through_to_run_segment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    w, h = 20, 16
    model_dir = _install_model(tmp_path)
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
        "model_dir": model_dir,
        "prompt": prompt,
    }
    payload = _rgba_payload(h, w)

    response_header, _ = handle_segment(header, payload)

    assert response_header["ok"] is True
    assert captured["prompt"] == prompt
    assert captured["coarse_mask"] is None
    assert captured["rgba"].shape == (h, w, 4)


def test_segment_decodes_appended_coarse_mask(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    w, h = 20, 16
    model_dir = _install_model(tmp_path)
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
        "model_dir": model_dir,
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


def test_segment_rejects_wrong_payload_size(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    model_dir = _install_model(tmp_path)
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
        "model_dir": model_dir,
        "prompt": {},
    }

    response_header, response_payload = handle_segment(header, b"too short")

    assert response_header["ok"] is False
    assert "payload" in response_header["error"]
    assert response_payload == b""
    assert called is False


def test_segment_requires_model_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
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


def test_segment_without_a_manifest_answers_model_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    # The folder exists with its files but no manifest.json: app-kit writes that last, so this
    # is a model that was removed or is still downloading. Nothing may touch the network.
    (tmp_path / ENCODER_FILENAME).write_bytes(b"encoder")
    (tmp_path / DECODER_FILENAME).write_bytes(b"decoder")

    def no_network(*args, **kwargs):
        raise AssertionError("the sidecar must not open a connection")

    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket.socket, "connect", no_network)

    def no_inference(**kwargs):
        raise AssertionError("must not run without the model")

    monkeypatch.setattr(segment_module, "run_segment", no_inference)

    header = {
        "id": "seg-6",
        "op": "segment",
        "width": 10,
        "height": 10,
        "model_dir": str(tmp_path),
        "prompt": {},
    }
    response_header, response_payload = handle_segment(header, _rgba_payload(10, 10))

    assert response_header["id"] == "seg-6"
    assert response_header["ok"] is False
    assert response_header["code"] == "model_missing"
    assert response_header["model"] == "mobile_sam"
    assert "mobile_sam" in response_header["error"]
    assert response_payload == b""


def test_segment_with_a_missing_model_dir_answers_model_missing(tmp_path: Path):
    header = {
        "id": "seg-8",
        "op": "segment",
        "width": 10,
        "height": 10,
        "model_dir": str(tmp_path / "not-there"),
        "prompt": {},
    }
    response_header, _ = handle_segment(header, _rgba_payload(10, 10))

    assert response_header["ok"] is False
    assert response_header["code"] == "model_missing"


def test_the_sidecar_opens_no_urls():
    sidecar = Path(segment_module.__file__).resolve().parent.parent
    clients = ("urllib", "requests", "http.client", "httpx", "import socket")
    offenders = [
        str(path.relative_to(sidecar))
        for folder in ("handlers", "ml")
        for path in (sidecar / folder).glob("*.py")
        if any(client in path.read_text() for client in clients)
    ]
    assert offenders == []


def test_segment_surfaces_inference_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    model_dir = _install_model(tmp_path)

    def boom(**kwargs):
        raise ValueError("bad prompt")

    monkeypatch.setattr(segment_module, "run_segment", boom)

    header = {
        "id": "seg-7",
        "op": "segment",
        "width": 10,
        "height": 10,
        "model_dir": model_dir,
        "prompt": {},
    }
    response_header, response_payload = handle_segment(header, _rgba_payload(10, 10))

    assert response_header["ok"] is False
    assert "bad prompt" in response_header["error"]
    assert response_payload == b""
