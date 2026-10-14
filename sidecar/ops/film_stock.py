"""`film_stock` — film-look grading as one op with a `stock` enum. Every
stock runs the same pipeline and only its numbers differ; those numbers are
the `_Stock` tuples below, in this file, because an op's parameter metadata
lives in its home backend.

**Pipeline, in order, on RGB in 0-1 (alpha untouched):**

1. **Cross-matrix.** A 3x3 mix of the input channels into each output
   channel. Rows sum to 1 so a neutral grey stays neutral going in; the
   colour character comes from the off-diagonals (desaturating, warming,
   or boosting saturation) and from the curves and tints after it.
2. **Tone curves, one per channel.** `(lift, ceil, gamma, contrast)`:
   `gamma` bends the midtones (above 1 darkens them), `contrast` is an
   S-curve strength (0 is straight; larger is harder), and the result is
   mapped into `[lift, ceil]`. A `lift` above 0 is the milky, raised black;
   a `ceil` below 1 is the dim, rolled-off white. Differing per-channel
   lifts and ceilings are what put a colour in the shadows or highlights
   (a lower blue ceiling makes creamy or amber highlights). A single
   `shoulder` per stock additionally flattens the top of the curve.
3. **Split-tone.** A signed RGB offset added in the shadows (weighted by
   `(1 - luma)^2`) and another in the highlights (weighted by `luma^2`).
4. **`amount`** blends steps 1-3 with the untouched input. `amount` governs
   the colour grade and nothing else: 0 leaves the colours exactly as
   they were, 1 is the full stock.
5. **Vignette**, independent of `amount`: darkens toward the frame edge.
6. **Grain**, independent of `amount`, added last.

`vignette` and `grain` are fractions of the *stock's own* full vignette and
grain: 1 gives the stock's full value (each stock has its own depth,
softness and grain strength), 0 turns it off.

**Resolution independence.** The vignette is built from coordinates
normalised to the frame (0 at the centre, 1 at the corners), so a draft and
a full-resolution cook darken the same fraction of the picture. Grain does
not take a `size` param (`grain.py` does, and the client divides its
`scale="spatial"` value by the resolution factor). Instead the grain speck is
a fixed fraction of the frame: the long edge always carries `_GRAIN_CELLS`
specks, so the specks grow and shrink with the buffer, and a draft shows the
same grain texture as the full-resolution picture, only smaller in pixels. A
fixed size would give a draft grain that is coarse relative to the picture
and a full-resolution cook grain that is too fine. Below `_GRAIN_CELLS`
pixels on the long edge the speck is clamped to one pixel. Grain is a seeded
`_noise.noise_field` (`rect` profile: nearest-neighbour blocks, the same
chunky look as `grain.py`), strongest in the midtones, with a per-stock
share of independent per-channel colour noise.

**Seed** matters only where randomness is used: grain, and the `expired`
stock, whose colour shift and magenta-or-cyan cast are a seeded pick.
`expired`'s pick is drawn whenever the stock is selected, independent of
`grain`, so scrubbing `grain` never changes the cast.

Alpha untouched. Pure NumPy (float32 working precision, one rounding at the
end).
"""

from __future__ import annotations

import math
from typing import Any, NamedTuple

import numpy as np

from ops import P, op
from ops._noise import noise_field

Vec3 = tuple[float, float, float]
Mat3 = tuple[Vec3, Vec3, Vec3]


class _Stock(NamedTuple):
    # Per-channel curves (R, G, B).
    lift: Vec3  # output at input black
    ceil: Vec3  # output at input white
    gamma: Vec3  # midtone bend; above 1 darkens
    contrast: Vec3  # S-curve strength; 0 is straight
    shoulder: float  # 0-0.25: flattens the top of the curve
    matrix: Mat3  # cross-matrix, rows are output R, G, B
    shadow_tint: Vec3  # signed RGB offset in the shadows
    highlight_tint: Vec3  # signed RGB offset in the highlights
    vignette_depth: float  # corner darkening at vignette = 1
    vignette_start: float  # radius (0 centre, 1 corner) where the falloff begins
    grain_strength: float  # grain std-dev at grain = 1, in 0-1 units
    grain_colour: float  # 0 mono grain .. 1 equal parts colour noise


_STOCKS: dict[str, _Stock] = {
    # Instant: lifted milky blacks, cyan-green shadows, warm creamy highlights,
    # low contrast, wide soft vignette.
    "polaroid_600": _Stock(
        lift=(0.08, 0.12, 0.13),
        ceil=(0.97, 0.95, 0.88),
        gamma=(1.0, 0.97, 1.0),
        contrast=(0.0, 0.0, 0.0),
        shoulder=0.12,
        matrix=((0.94, 0.08, -0.02), (-0.02, 1.04, -0.02), (-0.04, 0.10, 0.94)),
        shadow_tint=(-0.035, 0.02, 0.03),
        highlight_tint=(0.03, 0.015, -0.03),
        vignette_depth=0.40,
        vignette_start=0.25,
        grain_strength=0.10,
        grain_colour=0.3,
    ),
    # Instant, Faded: warmer and more faded than Instant, with browner shadows,
    # amber highlights and even lower contrast.
    "sx70": _Stock(
        lift=(0.12, 0.10, 0.07),
        ceil=(0.98, 0.91, 0.76),
        gamma=(0.95, 1.0, 1.12),
        contrast=(0.0, 0.0, 0.0),
        shoulder=0.18,
        matrix=((0.98, 0.10, -0.08), (0.02, 0.96, 0.02), (0.0, 0.10, 0.90)),
        shadow_tint=(0.03, 0.0, -0.02),
        highlight_tint=(0.045, 0.025, -0.05),
        vignette_depth=0.45,
        vignette_start=0.3,
        grain_strength=0.12,
        grain_colour=0.3,
    ),
    # E-6 slide film in C-41 chemistry: steep curves, a crushed blue
    # highlight (yellow-green), a lifted blue shadow, saturation pushed up.
    "cross_process": _Stock(
        lift=(0.0, 0.0, 0.11),
        ceil=(0.98, 1.0, 0.78),
        gamma=(1.1, 0.9, 0.85),
        contrast=(7.0, 5.5, 3.0),
        shoulder=0.0,
        matrix=((1.25, -0.15, -0.10), (-0.10, 1.25, -0.15), (-0.05, -0.20, 1.25)),
        shadow_tint=(-0.04, 0.0, 0.05),
        highlight_tint=(0.02, 0.04, -0.06),
        vignette_depth=0.30,
        vignette_start=0.45,
        grain_strength=0.14,
        grain_colour=0.5,
    ),
    # Silver retained: colour mostly stripped to luma, hard contrast, a cold
    # metallic edge in the shadows, no colour in the grain.
    "bleach_bypass": _Stock(
        lift=(0.0, 0.0, 0.01),
        ceil=(1.0, 1.0, 0.99),
        gamma=(1.05, 1.05, 1.05),
        contrast=(5.0, 5.0, 5.0),
        shoulder=0.0,
        matrix=(
            (0.5669, 0.3934, 0.0397),
            (0.1169, 0.8434, 0.0397),
            (0.1169, 0.3934, 0.4897),
        ),
        shadow_tint=(-0.01, 0.0, 0.02),
        highlight_tint=(0.0, 0.0, 0.0),
        vignette_depth=0.55,
        vignette_start=0.5,
        grain_strength=0.16,
        grain_colour=0.0,
    ),
    # Old stock, base of the look only: faded and lifted, a little
    # desaturated, heavy grain. `_expired_variant` adds the seeded colour
    # shift and the magenta or cyan cast on top.
    "expired": _Stock(
        lift=(0.07, 0.06, 0.07),
        ceil=(0.93, 0.92, 0.91),
        gamma=(1.0, 1.0, 1.0),
        contrast=(1.2, 1.2, 1.2),
        shoulder=0.1,
        matrix=((0.88, 0.10, 0.02), (0.06, 0.88, 0.06), (0.02, 0.10, 0.88)),
        shadow_tint=(0.0, 0.0, 0.0),
        highlight_tint=(0.0, 0.0, 0.0),
        vignette_depth=0.50,
        vignette_start=0.35,
        grain_strength=0.18,
        grain_colour=0.4,
    ),
}

# Cast offsets for `expired`: (shadow, highlight) signed RGB at full strength.
_MAGENTA_CAST: tuple[Vec3, Vec3] = ((0.03, -0.06, 0.03), (0.015, -0.03, 0.015))
_CYAN_CAST: tuple[Vec3, Vec3] = ((-0.06, 0.02, 0.035), (-0.03, 0.01, 0.02))

# Luma weights (Rec. 709).
_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# `noise_field` is uniform in [-1, 1] (std 1/sqrt(3)); this makes it unit std.
_UNIFORM_TO_STD = 3.0**0.5

# Specks along the frame's long edge — see the module docstring.
_GRAIN_CELLS = 1280


def _clamp(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(v):
        return default
    return max(lo, min(hi, v))


def _expired_variant(base: _Stock, seed: int) -> tuple[_Stock, str]:
    """`expired` with its seeded colour shift and cast applied. Returns the
    stock and the cast name (`"magenta"` or `"cyan"`). The same draws happen
    for every seed in the same order, so the result depends only on `seed`."""
    rng = np.random.default_rng(seed)
    cast_name = "magenta" if rng.integers(0, 2) == 0 else "cyan"
    strength = float(rng.uniform(0.6, 1.0))
    gamma_shift = rng.uniform(-0.12, 0.12, size=3)
    lift_shift = rng.uniform(-0.02, 0.02, size=3)

    shadow_cast, highlight_cast = (
        _MAGENTA_CAST if cast_name == "magenta" else _CYAN_CAST
    )
    stock = base._replace(
        gamma=tuple(float(g + d) for g, d in zip(base.gamma, gamma_shift)),  # type: ignore[arg-type]
        lift=tuple(float(max(0.0, v + d)) for v, d in zip(base.lift, lift_shift)),  # type: ignore[arg-type]
        shadow_tint=tuple(strength * c for c in shadow_cast),  # type: ignore[arg-type]
        highlight_tint=tuple(strength * c for c in highlight_cast),  # type: ignore[arg-type]
    )
    return stock, cast_name


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _curves(rgb: np.ndarray, s: _Stock) -> np.ndarray:
    """Per-channel tone curves on a float `(h, w, 3)` array in 0-1."""
    gamma = np.asarray(s.gamma, dtype=np.float32)
    lift = np.asarray(s.lift, dtype=np.float32)
    ceil = np.asarray(s.ceil, dtype=np.float32)

    x = np.clip(rgb, 0.0, 1.0) ** gamma
    if s.shoulder > 0.0:
        x = (x - s.shoulder * x**4) / (1.0 - s.shoulder)
    for c, k in enumerate(s.contrast):
        if k > 1e-6:
            lo, hi = (
                float(_sigmoid(np.float32(-k / 2))),
                float(_sigmoid(np.float32(k / 2))),
            )
            x[..., c] = (_sigmoid(np.float32(k) * (x[..., c] - 0.5)) - lo) / (hi - lo)
    return lift + (ceil - lift) * x


def _grade(rgb: np.ndarray, s: _Stock) -> np.ndarray:
    """Cross-matrix, curves, split-tone. Float `(h, w, 3)` in, 0-1 out."""
    mixed = np.clip(rgb @ np.asarray(s.matrix, dtype=np.float32).T, 0.0, 1.0)
    curved = _curves(mixed, s)
    luma = (curved @ _LUMA)[..., None]
    shadow_w = (1.0 - luma) ** 2
    highlight_w = luma**2
    toned = (
        curved
        + shadow_w * np.asarray(s.shadow_tint, dtype=np.float32)
        + highlight_w * np.asarray(s.highlight_tint, dtype=np.float32)
    )
    return np.clip(toned, 0.0, 1.0)


def _vignette_gain(h: int, w: int, depth: float, start: float) -> np.ndarray:
    """`(h, w, 1)` multiplier, 1 in the middle falling to `1 - depth` at the
    corners. Radius is frame-relative: 0 at the centre, 1 at a corner."""
    ny = (np.arange(h, dtype=np.float32) + 0.5) / h * 2.0 - 1.0
    nx = (np.arange(w, dtype=np.float32) + 0.5) / w * 2.0 - 1.0
    r = np.sqrt((ny[:, None] ** 2 + nx[None, :] ** 2) * 0.5)
    t = np.clip((r - start) / (1.0 - start), 0.0, 1.0)
    falloff = t * t * (3.0 - 2.0 * t)
    return (1.0 - depth * falloff)[..., None]


def _grain_cell(h: int, w: int) -> float:
    """Grain speck size in px: the long edge always holds `_GRAIN_CELLS`
    specks, clamped to 1 px."""
    return max(1.0, max(h, w) / _GRAIN_CELLS)


def _grain_noise(h: int, w: int, seed: int, colour: float) -> np.ndarray:
    """Float32 `(h, w, 3)` noise with unit-ish scale: a shared luma field
    plus `colour` of independent per-channel fields."""
    cell = _grain_cell(h, w)
    luma = noise_field(h, w, cell, seed * 4, "rect").astype(np.float32)
    out = np.repeat(luma[..., None], 3, axis=-1)
    if colour > 0.0:
        chroma = np.stack(
            [noise_field(h, w, cell, seed * 4 + 1 + c, "rect") for c in range(3)],
            axis=-1,
        ).astype(np.float32)
        out = (1.0 - colour) * out + colour * chroma
    return out


@op(
    "film_stock",
    category="film",
    label="Film stock",
    description=(
        "Grades the picture like a named film stock: tone curves with lifted "
        "blacks, a colour cross-mix, split-toned shadows and highlights, a "
        "vignette and grain."
    ),
    params=[
        P(
            "stock",
            "enum",
            default="polaroid_600",
            choices=tuple(_STOCKS),
            choice_labels={
                "polaroid_600": "Instant",
                "sx70": "Instant, Faded",
                "cross_process": "Cross Process",
                "bleach_bypass": "Bleach Bypass",
                "expired": "Expired",
            },
            label="Stock",
            description=(
                "Instant: milky lifted blacks, cyan-green shadows, warm creamy highlights, low contrast. "
                "Instant, Faded: warmer and more faded, with amber highlights and brown shadows. "
                "Cross Process: slide film in the wrong chemistry, with hard contrast, blue shadows and yellow-green highlights. "
                "Bleach Bypass: silver left in, so the colour is mostly gone and the contrast is hard and metallic. "
                "Expired: faded old stock with a seeded colour shift and a magenta or cyan cast."
            ),
        ),
        P(
            "amount",
            "float",
            min=0.0,
            max=1.0,
            default=1.0,
            step=0.05,
            widget="slider",
            label="Amount",
            description="How much of the stock's colour grade is mixed in. 0 leaves the colours as they were; 1 is the full stock. Vignette and grain have their own sliders.",
        ),
        P(
            "grain",
            "float",
            min=0.0,
            max=1.0,
            default=0.5,
            step=0.05,
            widget="slider",
            label="Grain",
            description="Film grain, as a share of the stock's own. 1 is the stock's full grain; 0 is none. The specks keep the same size relative to the picture at any resolution.",
        ),
        P(
            "vignette",
            "float",
            min=0.0,
            max=1.0,
            default=0.5,
            step=0.05,
            widget="slider",
            label="Vignette",
            description="Edge darkening, as a share of the stock's own. 1 is the stock's full vignette; 0 is none. It follows the frame, so it looks the same at any resolution.",
        ),
        P(
            "seed",
            "int",
            min=0,
            max=2**31 - 1,
            default=0,
            step=1,
            label="Seed",
            description="Changes the grain pattern and, for expired, the colour shift and which cast it gets.",
        ),
    ],
)
def film_stock(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    name = str(params.get("stock", "polaroid_600"))
    stock = _STOCKS.get(name, _STOCKS["polaroid_600"])
    amount = _clamp(params.get("amount", 1.0), 0.0, 1.0, 1.0)
    grain = _clamp(params.get("grain", 0.5), 0.0, 1.0, 0.5)
    vignette = _clamp(params.get("vignette", 0.5), 0.0, 1.0, 0.5)
    try:
        seed = int(params.get("seed", 0))
    except (TypeError, ValueError):
        seed = 0
    seed = max(0, seed)

    out = img.copy()
    if amount <= 0.0 and grain <= 0.0 and vignette <= 0.0:
        return out

    if name == "expired":
        stock, _ = _expired_variant(stock, seed)

    h, w = img.shape[:2]
    rgb = img[..., :3].astype(np.float32) / 255.0
    result = rgb
    if amount > 0.0:
        result = rgb + (_grade(rgb, stock) - rgb) * np.float32(amount)

    if vignette > 0.0:
        depth = vignette * stock.vignette_depth
        result = result * _vignette_gain(h, w, depth, stock.vignette_start)

    if grain > 0.0:
        noise = _grain_noise(h, w, seed, stock.grain_colour)
        # Midtones carry the grain; deep shadows and highlights keep some.
        luma = (result @ _LUMA)[..., None]
        weight = 0.35 + 0.65 * 4.0 * luma * (1.0 - luma)
        result = (
            result + noise * (grain * stock.grain_strength * _UNIFORM_TO_STD) * weight
        )

    out[..., :3] = np.clip(np.round(result * 255.0), 0.0, 255.0).astype(np.uint8)
    return out
