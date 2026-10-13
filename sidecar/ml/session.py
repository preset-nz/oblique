"""Lazy, process-lifetime onnxruntime sessions for MobileSAM, a one-entry
image-embedding cache keyed by the SHA-256 of the RGBA array's bytes (so
repeated prompts on the same image skip the encoder), and the point/box/
mask prompt -> thresholded mask inference.

Protocol-free: every function here takes NumPy arrays, `Path`s, and plain
Python values (a `prompt` dict, already extracted from the request header
by `handlers/segment.py`) — never a request header or raw payload bytes.
This module is scoped to move verbatim into a shared package later.

Preprocessing matches the Acly/MobileSAM ONNX export: the encoder graph
itself does mean/std normalisation, CHW permute, and padding to 1024x1024 —
callers only resize the RGB image so its longest side is exactly
`IMG_SIZE` (1024) before handing it to the encoder. Point/box coordinates
are scaled by that same resize factor before being passed to the decoder;
`orig_im_size` is the *original* (unresized) height/width, and the decoder
graph upsamples its output mask back to that size itself — no separate
upsample step needed on this side. CPU execution provider only, pinned
explicitly (locked decision: v1 has no GPU providers).
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image

IMG_SIZE = 1024
LOW_RES_SIZE = 256

# SAM ONNX point-label convention: 1 = positive click, 0 = negative click,
# 2 = box top-left corner, 3 = box bottom-right corner, -1 = padding
# ("not a point" — used when there are no real points at all, since the
# decoder graph requires at least one coordinate).
LABEL_POSITIVE = 1.0
LABEL_NEGATIVE = 0.0
LABEL_BOX_TOP_LEFT = 2.0
LABEL_BOX_BOTTOM_RIGHT = 3.0
LABEL_PADDING = -1.0

_PROVIDERS = ["CPUExecutionProvider"]

_encoder_session: ort.InferenceSession | None = None
_encoder_path: Path | None = None
_decoder_session: ort.InferenceSession | None = None
_decoder_path: Path | None = None

# One-entry LRU: repeated prompts on the same node/level/cook-stamp resend
# the same RGBA bytes, so a single slot keyed by their hash is enough —
# the next *different* image simply evicts it.
_embedding_cache: dict[str, tuple[np.ndarray, float]] = {}


def _get_encoder_session(encoder_path: Path) -> ort.InferenceSession:
    global _encoder_session, _encoder_path
    if _encoder_session is None or _encoder_path != encoder_path:
        _encoder_session = ort.InferenceSession(str(encoder_path), providers=_PROVIDERS)
        _encoder_path = encoder_path
    return _encoder_session


def _get_decoder_session(decoder_path: Path) -> ort.InferenceSession:
    global _decoder_session, _decoder_path
    if _decoder_session is None or _decoder_path != decoder_path:
        _decoder_session = ort.InferenceSession(str(decoder_path), providers=_PROVIDERS)
        _decoder_path = decoder_path
    return _decoder_session


def _resize_longest_side(
    rgb: np.ndarray, target: int = IMG_SIZE
) -> tuple[np.ndarray, float]:
    height, width = rgb.shape[:2]
    scale = target / max(height, width)
    new_h = max(1, round(height * scale))
    new_w = max(1, round(width * scale))
    resized = np.array(Image.fromarray(rgb).resize((new_w, new_h), Image.BILINEAR))
    return resized.astype(np.float32), scale


def _embed_image(
    encoder: ort.InferenceSession, rgba: np.ndarray, payload_hash: str
) -> tuple[np.ndarray, float]:
    cached = _embedding_cache.get(payload_hash)
    if cached is not None:
        return cached

    rgb = np.ascontiguousarray(rgba[..., :3])
    resized, scale = _resize_longest_side(rgb)
    (embedding,) = encoder.run(None, {"input_image": resized})

    _embedding_cache.clear()  # one-entry cache — evict before inserting
    _embedding_cache[payload_hash] = (embedding, scale)
    return embedding, scale


def _build_point_inputs(
    prompt: dict[str, Any], scale: float
) -> tuple[np.ndarray, np.ndarray]:
    coords: list[tuple[float, float]] = []
    labels: list[float] = []

    for point in prompt.get("points") or []:
        coords.append((float(point["x"]), float(point["y"])))
        labels.append(LABEL_POSITIVE if point.get("label") == 1 else LABEL_NEGATIVE)

    box = prompt.get("box")
    if box is not None:
        coords.append((float(box["x0"]), float(box["y0"])))
        labels.append(LABEL_BOX_TOP_LEFT)
        coords.append((float(box["x1"]), float(box["y1"])))
        labels.append(LABEL_BOX_BOTTOM_RIGHT)

    if not coords:
        # The decoder graph requires at least one coordinate; a padding
        # point (label -1) at the origin contributes no prompt embedding.
        coords.append((0.0, 0.0))
        labels.append(LABEL_PADDING)

    coords_arr = np.array(coords, dtype=np.float32) * scale
    point_coords = coords_arr[None, :, :]
    point_labels = np.array(labels, dtype=np.float32)[None, :]
    return point_coords, point_labels


def _build_mask_inputs(coarse_mask: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    if coarse_mask is None:
        mask_input = np.zeros((1, 1, LOW_RES_SIZE, LOW_RES_SIZE), dtype=np.float32)
        has_mask_input = np.array([0.0], dtype=np.float32)
        return mask_input, has_mask_input

    # The client sends a rasterised 0/255 coarse mask, not decoder logits.
    # Map it into a logit-like range so mask_downscaling (trained on the
    # decoder's own low-res logits) sees a confidently signed input rather
    # than raw 0/1 — magnitude chosen to sit near the range MobileSAM's own
    # low-res mask logits occupy, no calibration data available for v1.
    normalised = (coarse_mask.astype(np.float32) / 255.0) * 2.0 - 1.0  # [-1, 1]
    mask_input = (normalised * 16.0).reshape(1, 1, LOW_RES_SIZE, LOW_RES_SIZE)
    has_mask_input = np.array([1.0], dtype=np.float32)
    return mask_input, has_mask_input


def _array_hash(rgba: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(rgba).tobytes()).hexdigest()


def run_segment(
    *,
    encoder_path: Path,
    decoder_path: Path,
    rgba: np.ndarray,
    prompt: dict[str, Any],
    coarse_mask: np.ndarray | None,
) -> np.ndarray:
    """Run MobileSAM for one prompt against `rgba` (H, W, 4 uint8).

    Returns a bool mask (H, W) — the decoder's upsampled mask thresholded
    at 0, already at `rgba`'s own resolution (the decoder graph upsamples
    internally from `orig_im_size`).
    """
    height, width = rgba.shape[:2]
    encoder = _get_encoder_session(encoder_path)
    decoder = _get_decoder_session(decoder_path)

    embedding, scale = _embed_image(encoder, rgba, _array_hash(rgba))
    point_coords, point_labels = _build_point_inputs(prompt, scale)
    mask_input, has_mask_input = _build_mask_inputs(coarse_mask)
    orig_im_size = np.array([height, width], dtype=np.float32)

    outputs = decoder.run(
        None,
        {
            "image_embeddings": embedding,
            "point_coords": point_coords,
            "point_labels": point_labels,
            "mask_input": mask_input,
            "has_mask_input": has_mask_input,
            "orig_im_size": orig_im_size,
        },
    )
    masks = outputs[0]  # [1, 1, H, W] logits, already resized to orig_im_size
    return masks[0, 0] > 0.0
