"""MobileSAM weight fetch (Apache-2.0, ONNX export by Acly — the same pair
used by the Krita AI plugin's interactive segmentation feature). Weights are
not bundled: `ensure_weights` downloads the image encoder + prompt decoder
into `<model_dir>/mobile_sam/` on first use and verifies a pinned SHA-256 on
every call thereafter (cheap: a local file hash, no network once present).

Download is synchronous inside the request that needs it — no progress
frames; the sidecar protocol stays plain request/response (orchestrator's
call for this story, see segment-to-vector.md deviations in the story's
commit).
"""

from __future__ import annotations

import hashlib
import urllib.request
from collections.abc import Callable
from pathlib import Path

MODEL_SUBDIR = "mobile_sam"

ENCODER_FILENAME = "mobile_sam_image_encoder.onnx"
DECODER_FILENAME = "sam_mask_decoder_single.onnx"

# Source: https://huggingface.co/Acly/MobileSAM (MIT), exported from
# MobileSAM (Apache-2.0, https://github.com/ChaoningZhang/MobileSAM) via
# the repo's own export_image_encoder.py / MobileSAM's export_models.py.
# Single-mask decoder chosen (not the 4-mask variant) — v1 always takes the
# decoder's own best mask, no client-side mask picking.
ENCODER_URL = (
    "https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx"
)
DECODER_URL = (
    "https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx"
)

# Verified 2026-09-10 against the files served at the URLs above.
ENCODER_SHA256 = "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749"
DECODER_SHA256 = "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d"

ENCODER_SIZE_BYTES = 28_157_093
DECODER_SIZE_BYTES = 16_501_323

Downloader = Callable[[str, Path], None]


def _default_downloader(url: str, dest: Path) -> None:
    with urllib.request.urlopen(url) as response, open(dest, "wb") as f:
        while chunk := response.read(1 << 20):
            f.write(chunk)


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _ensure_one(
    path: Path, url: str, expected_sha256: str, downloader: Downloader
) -> Path:
    if path.exists():
        actual = _sha256_of(path)
        if actual == expected_sha256:
            return path
        # Corrupted or tampered file: refuse it and delete, rather than
        # silently re-downloading mid-request — the caller sees a clear
        # error; the next call (retry) finds no file and fetches fresh.
        path.unlink()
        raise RuntimeError(
            f"model weight {path.name} failed checksum verification "
            f"(expected {expected_sha256}, got {actual}) — deleted, retry to re-download"
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".part")
    downloader(url, tmp_path)

    actual = _sha256_of(tmp_path)
    if actual != expected_sha256:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"downloaded model weight {path.name} failed checksum verification "
            f"(expected {expected_sha256}, got {actual}) — deleted"
        )
    tmp_path.replace(path)
    return path


def ensure_weights(
    model_dir: Path, *, downloader: Downloader = _default_downloader
) -> tuple[Path, Path]:
    """Return (encoder_path, decoder_path) under `<model_dir>/mobile_sam/`,
    downloading whichever is missing. Raises on a checksum mismatch, after
    deleting the bad file so the next call retries the download cleanly.
    """
    target_dir = Path(model_dir) / MODEL_SUBDIR
    encoder_path = _ensure_one(
        target_dir / ENCODER_FILENAME, ENCODER_URL, ENCODER_SHA256, downloader
    )
    decoder_path = _ensure_one(
        target_dir / DECODER_FILENAME, DECODER_URL, DECODER_SHA256, downloader
    )
    return encoder_path, decoder_path
