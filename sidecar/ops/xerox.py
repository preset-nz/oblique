"""`xerox` — photocopy generation loss: the image as it degrades through
repeated copy-of-a-copy passes on a tired machine. Each generation blows
out contrast a little further and lets the exposure threshold drift, a
slight rotation creeps in from a crooked platen, and toner-starved
speckle builds up in the dark fields, with a soft bloom haloing the
remaining edges. Streak banding is deliberately NOT here — bands are
generator-shaped content, not copy degradation (see ops-backlog's
operators-vs-generators note; `roller_streaks` owns that look).
Mono (Rec. 709) by default, since photocopiers don't do colour; RGBA
in/out at the same size, alpha untouched.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from ops import P, op

_LUMA_R, _LUMA_G, _LUMA_B = 0.2126, 0.7152, 0.0722


def _to_mono(rgb: np.ndarray) -> np.ndarray:
    luma = rgb[..., 0] * _LUMA_R + rgb[..., 1] * _LUMA_G + rgb[..., 2] * _LUMA_B
    return np.stack([luma, luma, luma], axis=-1)


def _rotate_same_size(rgb_u8: np.ndarray, angle_deg: float) -> np.ndarray:
    """Rotate by a small angle and centre-crop back to the original size —
    same-size contract preserved, no black corners for skew this small."""
    if abs(angle_deg) < 1e-6:
        return rgb_u8

    h, w = rgb_u8.shape[:2]
    src = Image.fromarray(rgb_u8, mode="RGB")
    rotated = src.rotate(
        angle_deg, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255)
    )
    rw, rh = rotated.size
    left = max(0, (rw - w) // 2)
    top = max(0, (rh - h) // 2)
    cropped = rotated.crop((left, top, left + w, top + h))
    return np.asarray(cropped, dtype=np.uint8)


def _gradient_magnitude(gray: np.ndarray) -> np.ndarray:
    """Cheap Sobel-free edge magnitude (central differences); good enough
    for a soft bloom mask, and keeps the sidecar scipy-free."""
    gx = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy = np.zeros_like(gray)
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    return np.hypot(gx, gy)


@op(
    "xerox",
    params=[
        P("generations", "int", min=1, max=10, default=3, step=1),
        P("skew", "float", min=0.0, max=2.0, default=0.3, step=0.05),
        P("toner_noise", "float", min=0.0, max=1.0, default=0.15, step=0.01),
        P("edge_bloom", "float", min=0.0, max=1.0, default=0.1, step=0.01),
        P(
            "bloom_radius",
            "float",
            min=0.5,
            max=16.0,
            default=3.0,
            step=0.5,
            scale="spatial",
        ),
        P("keep_colour", "bool", default=False),
        P("seed", "int", min=0, max=2**31 - 1, default=0, step=1),
    ],
)
def xerox(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    generations = max(1, min(10, int(params.get("generations", 3))))
    skew = float(params.get("skew", 0.3))
    toner_noise = float(params.get("toner_noise", 0.15))
    edge_bloom = float(params.get("edge_bloom", 0.1))
    bloom_radius = max(0.5, float(params.get("bloom_radius", 3.0)))
    keep_colour = bool(params.get("keep_colour", False))
    seed = int(params.get("seed", 0))

    rng = np.random.default_rng(seed)
    h, w = img.shape[:2]

    rgb_f = img[..., :3].astype(np.float64)
    if not keep_colour:
        rgb_f = _to_mono(rgb_f)

    for gen in range(generations):
        frac = (gen + 1) / generations

        if skew > 0.0:
            angle = float(rng.uniform(-skew, skew))
            rgb_u8 = np.clip(rgb_f, 0.0, 255.0).astype(np.uint8)
            rgb_u8 = _rotate_same_size(rgb_u8, angle)
            rgb_f = rgb_u8.astype(np.float64)

        # Contrast blowout: each pass pushes mid-tones further apart.
        contrast_factor = 1.0 + 0.35 * frac
        # Threshold drift: the effective exposure midpoint wanders a little
        # each generation, seeded, simulating an inconsistent exposure lamp.
        drift = float(rng.uniform(-1.0, 1.0)) * 6.0 * frac
        mid = 127.5 + drift
        rgb_f = (rgb_f - mid) * contrast_factor + mid
        rgb_f = np.clip(rgb_f, 0.0, 255.0)

    if toner_noise > 0.0:
        luma = rgb_f.mean(axis=-1)
        dark_mask = 1.0 - luma / 255.0  # 1 in dark fields, 0 in bright
        speckle_prob = toner_noise * 0.5 * dark_mask
        speckle_hit = rng.random((h, w)) < speckle_prob
        speckle_value = rng.uniform(160.0, 255.0, size=(h, w))
        rgb_f = np.where(speckle_hit[..., None], speckle_value[..., None], rgb_f)

    if edge_bloom > 0.0:
        luma = rgb_f.mean(axis=-1)
        edges = _gradient_magnitude(luma)
        edge_img = Image.fromarray(
            np.clip(edges, 0.0, 255.0).astype(np.uint8), mode="L"
        )
        bloom = np.asarray(
            edge_img.filter(ImageFilter.GaussianBlur(radius=bloom_radius)),
            dtype=np.float64,
        )
        bloom = bloom / 255.0 * edge_bloom
        # Screen blend: brightens without ever exceeding 255.
        rgb_f = 255.0 - (255.0 - rgb_f) * (1.0 - bloom[..., None])
        rgb_f = np.clip(rgb_f, 0.0, 255.0)

    out = img.copy()
    out[..., :3] = rgb_f.astype(np.uint8)
    return out
