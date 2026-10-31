"""Depth Anything V2 Small: one RGBA raster in, one relative-depth plane out.

Protocol-free like `session.py`: NumPy arrays, `Path`s and plain values only. The request header,
the payload bytes and the PNG encoding belong to `handlers/depth.py`. This module is scoped to
move verbatim into a shared package later.

Preprocessing follows the model repo's `preprocessor_config.json` (checked 2026-10-31 at the
pinned revision): bicubic resize keeping the aspect ratio, both sides a multiple of 14, divide
by 255, then ImageNet mean and std. The model sees 518 px on the short side; the long side is
capped (`MAX_LONG_SIDE`) so a panorama doesn't ask for a 10 000 px tensor.

The output of the graph is relative inverse depth (larger is nearer) at the model's own size.
It is resized back to the source's size (bilinear) and normalised min to max, so near is 1.0.
The normalising range comes from the visible pixels (alpha above 0) when there are any: the
transparent part of a cut-out would otherwise squeeze the range of what is left.

CPU execution provider in the shipped path (`get_session`). `load_session` takes the providers
so `sidecar/bench/depth_providers.py` can measure CoreML against it without a second copy of
the maths.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image

from ml.session import MANIFEST_FILENAME, ModelNotInstalled

# The model's id in app-kit's registry (`src-tauri/src/models.rs`) and the file it installs.
MODEL_ID = "depth_anything_v2_small"
MODEL_FILENAME = "model.onnx"

SHORT_SIDE = 518
MULTIPLE = 14
MAX_LONG_SIDE = 1568  # 112 * 14
IMAGE_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGE_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

_PROVIDERS = ["CPUExecutionProvider"]

_session: ort.InferenceSession | None = None
_session_path: Path | None = None


def weight_path(model_dir: Path) -> Path:
    """The weights under `model_dir`. Raises `ModelNotInstalled` without a manifest, which
    app-kit writes last, once the file has passed its SHA-256."""
    model_dir = Path(model_dir)
    if not (model_dir / MANIFEST_FILENAME).is_file():
        raise ModelNotInstalled(MODEL_ID)
    return model_dir / MODEL_FILENAME


def load_session(
    model_path: Path,
    providers: list[Any] | None = None,
    sess_options: ort.SessionOptions | None = None,
) -> ort.InferenceSession:
    """A new session. `providers` defaults to the CPU provider; entries may be `(name, options)`."""
    return ort.InferenceSession(
        str(model_path),
        sess_options=sess_options,
        providers=providers or _PROVIDERS,
    )


def get_session(model_path: Path) -> ort.InferenceSession:
    """The process-lifetime CPU session, rebuilt when the path changes."""
    global _session, _session_path
    if _session is None or _session_path != model_path:
        _session = load_session(model_path)
        _session_path = model_path
    return _session


def _to_multiple(value: float) -> int:
    return max(MULTIPLE, round(value / MULTIPLE) * MULTIPLE)


def model_input_size(height: int, width: int) -> tuple[int, int]:
    """(height, width) the model is fed for a `height` x `width` source: short side 518, the
    aspect ratio kept, both sides a multiple of 14, the long side at most `MAX_LONG_SIDE`."""
    scale = SHORT_SIDE / min(height, width)
    new_h, new_w = height * scale, width * scale
    longest = max(new_h, new_w)
    if longest > MAX_LONG_SIDE:
        shrink = MAX_LONG_SIDE / longest
        new_h, new_w = new_h * shrink, new_w * shrink
        # Round down here, so the cap holds after snapping to the multiple.
        return (
            max(MULTIPLE, int(new_h / MULTIPLE + 1e-6) * MULTIPLE),
            max(MULTIPLE, int(new_w / MULTIPLE + 1e-6) * MULTIPLE),
        )
    return _to_multiple(new_h), _to_multiple(new_w)


def preprocess(rgba: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """RGBA (H, W, 4) uint8 -> the model's input: (1, 3, h, w) float32, `size` = (h, w)."""
    rgb = Image.fromarray(np.ascontiguousarray(rgba[..., :3]), "RGB")
    resized = rgb.resize((size[1], size[0]), Image.BICUBIC)
    scaled = np.asarray(resized, dtype=np.float32) / 255.0
    normalised = (scaled - IMAGE_MEAN) / IMAGE_STD
    return np.ascontiguousarray(normalised.transpose(2, 0, 1)[None], dtype=np.float32)


def normalise_depth(depth: np.ndarray, alpha: np.ndarray | None = None) -> np.ndarray:
    """Min to max over the visible pixels -> float32 in [0, 1], near is 1. A flat plane is 0."""
    depth = depth.astype(np.float32, copy=False)
    sample = depth
    if alpha is not None:
        visible = alpha > 0
        if visible.any():
            sample = depth[visible]
    low, high = float(sample.min()), float(sample.max())
    span = high - low
    if span < 1e-6:
        return np.zeros_like(depth)
    return np.clip((depth - low) / span, 0.0, 1.0).astype(np.float32)


def estimate_depth(
    session: Any,
    rgba: np.ndarray,
    *,
    input_size: tuple[int, int] | None = None,
) -> np.ndarray:
    """Relative depth for `rgba` (H, W, 4 uint8): float32 (H, W) in [0, 1], near is 1.

    `session` is anything with an onnxruntime session's `get_inputs()` and `run()`, which is how
    the tests stand in for the model. `input_size` = (h, w) overrides the aspect-preserving
    size: the CoreML bench pins it to 518 x 518, since a dynamic shape sends CoreML to the CPU.
    """
    height, width = rgba.shape[:2]
    size = input_size or model_input_size(height, width)
    tensor = preprocess(rgba, size)
    input_name = session.get_inputs()[0].name
    (predicted,) = session.run(None, {input_name: tensor})
    raw = np.asarray(predicted, dtype=np.float32)
    plane = raw.reshape(raw.shape[-2:])
    if plane.shape != (height, width):
        resized = Image.fromarray(plane, "F").resize((width, height), Image.BILINEAR)
        plane = np.asarray(resized, dtype=np.float32)
    return normalise_depth(plane, rgba[..., 3])


def quantise(depth: np.ndarray, bits: int) -> np.ndarray:
    """[0, 1] float -> uint8 (`bits` 8) or uint16 (`bits` 16)."""
    if bits == 16:
        return np.rint(depth * 65535.0).astype(np.uint16)
    return np.rint(depth * 255.0).astype(np.uint8)


def run_depth(*, model_path: Path, rgba: np.ndarray) -> np.ndarray:
    """The shipped path: the CPU session over `model_path`, depth in [0, 1] at `rgba`'s size."""
    return estimate_depth(get_session(model_path), rgba)
