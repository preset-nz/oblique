"""`depth` handler and `ml/depth.py` tests. CI has no weights and no network, so the session is a
fake that returns a known plane at whatever size it is fed; the model files are stubs behind a
`manifest.json`, as app-kit leaves a finished download. The ONNX runtime is never touched.
"""

from __future__ import annotations

import io
import struct
import zlib
from pathlib import Path

import ml.depth as depth_module
import numpy as np
import pytest
from handlers.depth import encode_grey_alpha_png, handle_depth
from main import dispatch
from ml.depth import (
    MANIFEST_FILENAME,
    MODEL_FILENAME,
    estimate_depth,
    model_input_size,
    normalise_depth,
    preprocess,
    quantise,
)
from PIL import Image


class _Input:
    name = "pixel_values"


class FakeSession:
    """Returns a left-to-right ramp (larger on the right, so 'nearer') at the size it is fed."""

    def __init__(self) -> None:
        self.seen: list[np.ndarray] = []

    def get_inputs(self) -> list[_Input]:
        return [_Input()]

    def run(self, _outputs, feeds):
        tensor = feeds["pixel_values"]
        self.seen.append(tensor)
        _, _, h, w = tensor.shape
        ramp = np.tile(np.linspace(2.0, 12.0, w, dtype=np.float32), (h, 1))
        return [ramp[None]]


def _rgba(h: int, w: int, alpha: int = 255, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    rgba = rng.integers(0, 256, size=(h, w, 4), dtype=np.uint8)
    rgba[..., 3] = alpha
    return rgba


def _install_model(model_dir: Path) -> str:
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / MODEL_FILENAME).write_bytes(b"onnx")
    (model_dir / MANIFEST_FILENAME).write_text('{"id": "depth_anything_v2_small"}')
    return str(model_dir)


@pytest.fixture
def fake_session(monkeypatch: pytest.MonkeyPatch) -> FakeSession:
    session = FakeSession()
    monkeypatch.setattr(depth_module, "get_session", lambda _path: session)
    return session


def _read_png16(png: bytes) -> tuple[dict[str, int], np.ndarray]:
    """Decode our own colour-type-4 16-bit PNG with the stdlib: the IHDR fields and (H, W, 2)."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, ihdr = 8, b"", {}
    while pos < len(png):
        (length,) = struct.unpack(">I", png[pos : pos + 4])
        kind = png[pos + 4 : pos + 8]
        data = png[pos + 8 : pos + 8 + length]
        (crc,) = struct.unpack(">I", png[pos + 8 + length : pos + 12 + length])
        assert crc == zlib.crc32(kind + data)
        if kind == b"IHDR":
            w, h, depth, colour = struct.unpack(">IIBB", data[:10])
            ihdr = {"w": w, "h": h, "depth": depth, "colour": colour}
        elif kind == b"IDAT":
            idat += data
        pos += 12 + length
    raw = np.frombuffer(zlib.decompress(idat), dtype=np.uint8)
    rows = raw.reshape(ihdr["h"], 1 + ihdr["w"] * 4)
    assert (rows[:, 0] == 0).all()  # filter type 0 on every row
    pixels = rows[:, 1:].copy().view(">u2").reshape(ihdr["h"], ihdr["w"], 2)
    return ihdr, pixels.astype(np.uint16)


# ---- ml/depth.py ----


@pytest.mark.parametrize(
    ("height", "width", "expected"),
    [
        (518, 518, (518, 518)),
        (
            1365,
            2048,
            (518, 784),
        ),  # short side 518, long side rounded to a multiple of 14
        (4096, 4096, (518, 518)),
        (100, 100, (518, 518)),  # small images go up to 518
        (200, 300, (518, 784)),
        (500, 12000, (56, 1568)),  # capped long side, both still multiples of 14
    ],
)
def test_model_input_size(height, width, expected):
    assert model_input_size(height, width) == expected
    for side in expected:
        assert side % 14 == 0


def test_preprocess_normalises_with_the_imagenet_stats():
    rgba = np.zeros((20, 30, 4), dtype=np.uint8)
    rgba[..., 0] = 255  # pure red
    tensor = preprocess(rgba, (28, 42))
    assert tensor.shape == (1, 3, 28, 42)
    assert tensor.dtype == np.float32
    assert tensor[0, 0, 5, 5] == pytest.approx((1.0 - 0.485) / 0.229, abs=1e-4)
    assert tensor[0, 1, 5, 5] == pytest.approx((0.0 - 0.456) / 0.224, abs=1e-4)
    assert tensor[0, 2, 5, 5] == pytest.approx((0.0 - 0.406) / 0.225, abs=1e-4)


def test_normalise_depth_is_min_max_and_a_flat_plane_is_zero():
    plane = np.array([[1.0, 3.0], [5.0, 9.0]], dtype=np.float32)
    out = normalise_depth(plane)
    assert out.min() == 0.0
    assert out.max() == 1.0
    assert np.all(normalise_depth(np.full((3, 3), 4.0, dtype=np.float32)) == 0.0)


def test_normalise_depth_ranges_over_the_visible_pixels_only():
    plane = np.array([[100.0, 2.0, 4.0]], dtype=np.float32)
    alpha = np.array([[0, 255, 255]], dtype=np.uint8)
    out = normalise_depth(plane, alpha)
    assert out[0, 1] == 0.0
    assert out[0, 2] == 1.0
    assert out[0, 0] == 1.0  # outside the range, clipped; hidden by its alpha anyway


def test_estimate_depth_returns_the_source_size_with_near_as_one(fake_session):
    rgba = _rgba(40, 70)
    out = estimate_depth(fake_session, rgba)
    assert out.shape == (40, 70)
    assert out.dtype == np.float32
    assert out.min() == pytest.approx(0.0)
    assert out.max() == pytest.approx(1.0)
    assert out[:, -1].min() > out[:, 0].max()  # right is nearer
    # the model was fed the aspect-preserving size, not the source's
    assert fake_session.seen[0].shape == (1, 3, *model_input_size(40, 70))


def test_estimate_depth_honours_a_fixed_input_size(fake_session):
    out = estimate_depth(fake_session, _rgba(40, 70), input_size=(518, 518))
    assert fake_session.seen[0].shape == (1, 3, 518, 518)
    assert out.shape == (40, 70)


def test_quantise_levels():
    depth = np.array([0.0, 0.5, 1.0], dtype=np.float32)
    assert quantise(depth, 8).tolist() == [0, 128, 255]
    assert quantise(depth, 8).dtype == np.uint8
    assert quantise(depth, 16).tolist() == [0, 32768, 65535]
    assert quantise(depth, 16).dtype == np.uint16


# ---- handlers/depth.py ----


def _header(model_dir: str, h: int, w: int, **extra) -> dict:
    return {
        "id": "d-1",
        "op": "depth",
        "width": w,
        "height": h,
        "model_dir": model_dir,
        **extra,
    }


def test_depth_8bit_is_grey_with_the_source_alpha(fake_session, tmp_path):
    h, w = 24, 36
    rgba = _rgba(h, w)
    rgba[:, :6, 3] = 0  # a cut-out edge
    rgba[:, 6:12, 3] = 90
    header, payload = handle_depth(
        _header(_install_model(tmp_path), h, w), rgba.tobytes()
    )

    assert header == {"id": "d-1", "ok": True, "width": w, "height": h, "bits": 8}
    image = Image.open(io.BytesIO(payload))
    assert image.format == "PNG"
    assert image.mode == "LA"
    assert image.size == (w, h)
    grey, alpha = (np.array(band) for band in image.split())
    assert np.array_equal(alpha, rgba[..., 3])
    visible = rgba[..., 3] > 0
    assert grey[visible].min() == 0 and grey[visible].max() == 255
    assert grey[:, -1].min() > grey[:, 6].max()  # near is white


def test_depth_16bit_writes_a_16_bit_grey_alpha_png(fake_session, tmp_path):
    h, w = 16, 50
    rgba = _rgba(h, w)
    rgba[:2, :, 3] = 0
    header, payload = handle_depth(
        _header(_install_model(tmp_path), h, w, bits=16), rgba.tobytes()
    )

    assert header["ok"] is True and header["bits"] == 16
    ihdr, pixels = _read_png16(payload)
    assert ihdr == {"w": w, "h": h, "depth": 16, "colour": 4}
    grey, alpha = pixels[..., 0], pixels[..., 1]
    assert np.array_equal(alpha, rgba[..., 3].astype(np.uint16) * 257)
    visible = rgba[..., 3] > 0
    assert grey[visible].min() == 0 and grey[visible].max() == 65535
    # more than 256 distinct levels survive: this is not an 8-bit map in a 16-bit file
    assert len(np.unique(grey[visible])) > 40
    # a PNG reader that does not know colour type 4 by name still opens it
    assert Image.open(io.BytesIO(payload)).size == (w, h)


def test_the_16_bit_encoder_round_trips_exact_values():
    grey = np.array([[0, 1, 65535], [256, 40000, 12345]], dtype=np.uint16)
    alpha = np.array([[0, 128, 255], [255, 1, 7]], dtype=np.uint8)
    _, pixels = _read_png16(encode_grey_alpha_png(grey, alpha, 16))
    assert np.array_equal(pixels[..., 0], grey)
    assert np.array_equal(pixels[..., 1], alpha.astype(np.uint16) * 257)


def test_depth_with_no_manifest_answers_model_missing(tmp_path):
    h, w = 8, 8
    header, payload = handle_depth(
        _header(str(tmp_path / "absent"), h, w), _rgba(h, w).tobytes()
    )
    assert header["ok"] is False
    assert header["code"] == "model_missing"
    assert header["model"] == "depth_anything_v2_small"
    assert payload == b""


@pytest.mark.parametrize(
    "mutate",
    [
        lambda hd: hd.update(width=0),
        lambda hd: hd.update(height="8"),
        lambda hd: hd.update(model_dir=""),
        lambda hd: hd.update(bits=12),
    ],
)
def test_depth_rejects_a_bad_header(mutate, tmp_path):
    header = _header(_install_model(tmp_path), 8, 8)
    mutate(header)
    response, payload = handle_depth(header, _rgba(8, 8).tobytes())
    assert response["ok"] is False
    assert "code" not in response
    assert payload == b""


def test_depth_rejects_a_payload_of_the_wrong_size(tmp_path):
    response, _ = handle_depth(_header(_install_model(tmp_path), 8, 8), b"\x00" * 10)
    assert response["ok"] is False
    assert "payload bytes" in response["error"]


def test_depth_turns_a_model_failure_into_an_error_not_a_crash(monkeypatch, tmp_path):
    def boom(_path):
        raise RuntimeError("onnx exploded")

    monkeypatch.setattr(depth_module, "get_session", boom)
    response, payload = handle_depth(
        _header(_install_model(tmp_path), 8, 8), _rgba(8, 8).tobytes()
    )
    assert response == {"id": "d-1", "ok": False, "error": "onnx exploded"}
    assert payload == b""


def test_dispatch_routes_depth(fake_session, tmp_path):
    h, w = 10, 12
    header, payload = dispatch(
        _header(_install_model(tmp_path), h, w), _rgba(h, w).tobytes()
    )
    assert header["ok"] is True
    assert Image.open(io.BytesIO(payload)).size == (w, h)
