"""Dye Transfer (op id `technicolor`) — dye-transfer colour, not a tint. The
image is split into colour records, rebuilt as subtractive dyes (cyan, magenta, yellow) with
cross-talk between them and a density curve, printed slightly out of
register, then blended with the original. That is what gives three-strip
prints their saturated reds, teal-cyans and slightly unreal skin.

**Records.** A camera behind a beam splitter exposed one black-and-white
negative per colour record:

- `three_strip`: the red, green and blue channels, one record each.
- `two_strip`: the 1920s process. Only a red-orange record (mostly red, a
  little green) and a cyan-green record (green and blue averaged) exist, so
  there is no true blue. The cyan-green record drives both the magenta and the
  yellow dye, which is why blues collapse toward cyan-green and the print
  has no blue to give. Both mixes sum to 1, so neutrals stay neutral.

**Dyes.** Each record is inverted into the amount of its complementary dye:
cyan from the red record, magenta from green, yellow from blue. The
cross-talk matrix then bleeds each dye amount into its neighbours (rows sum
to 1, so a neutral stays neutral at any strength). Finally the per-channel
density curve turns dye amount into transmitted light, `(1 - amount) **
dye_density`: 1 is a plain subtractive print, above 1 is a denser dye with
deeper, more saturated colour and darker shadows, below 1 a thin, pale dye,
and 0 is clear film (white).

**Fringe.** Each record is shifted by its own seeded offset, up to `fringe`
document pixels in each direction, *before* the dyes are built — bilinear,
with edge clamping — so hard edges pick up coloured halos. `fringe` is
`scale="spatial"`: the client passes it already divided by the resolution
factor, so a draft cook shifts by the same fraction of the picture as the
full-resolution one. The three offsets are drawn from the seed at every
setting, so scrubbing `fringe` slides the records along fixed directions
instead of reshuffling them.

Alpha untouched. Pure NumPy.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ops import P, op

# Two-strip record mixes. Both sum to 1 so a grey gives equal records.
_RED_ORANGE_MIX = (0.85, 0.15, 0.0)
_CYAN_GREEN_MIX = (0.0, 0.5, 0.5)

# Off-diagonal bleed shares per dye (cyan, magenta, yellow). Each row sums to
# 1 so the matrix below keeps neutrals neutral. Magenta sits between the other
# two and takes from both; cyan and yellow mostly bleed toward magenta.
_BLEED = np.array(
    [
        [0.0, 0.7, 0.3],
        [0.5, 0.0, 0.5],
        [0.3, 0.7, 0.0],
    ],
    dtype=np.float64,
)
# At cross_talk=1 each dye keeps this share of itself.
_MAX_BLEED = 0.5


def _clamp(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(v):
        return default
    return max(lo, min(hi, v))


def _record_offsets(seed: int, fringe: float) -> np.ndarray:
    """`(3, 2)` per-record `(dx, dy)` in px. Always drawn, even at fringe 0,
    so the directions are stable while `fringe` is scrubbed."""
    rng = np.random.default_rng(seed)
    return rng.uniform(-1.0, 1.0, size=(3, 2)) * fringe


def _axis_taps(n: int, shift: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bilinear taps for `out[i] = in[i - shift]`, edge-clamped."""
    pos = np.clip(np.arange(n, dtype=np.float64) - shift, 0.0, n - 1.0)
    i0 = np.floor(pos).astype(np.intp)
    i1 = np.minimum(i0 + 1, n - 1)
    return i0, i1, pos - i0


def _shift_record(plane: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """Shift a float `(h, w)` plane by `(dx, dy)` px, bilinear, edge-clamped."""
    h, w = plane.shape
    out = plane
    if dx != 0.0:
        i0, i1, f = _axis_taps(w, dx)
        out = out[:, i0] * (1.0 - f) + out[:, i1] * f
    if dy != 0.0:
        i0, i1, f = _axis_taps(h, dy)
        out = out[i0, :] * (1.0 - f)[:, None] + out[i1, :] * f[:, None]
    return out


def _cross_talk_matrix(cross_talk: float) -> np.ndarray:
    strength = _MAX_BLEED * cross_talk
    return (1.0 - strength) * np.eye(3) + strength * _BLEED


@op(
    "technicolor",
    category="film",
    label="Dye Transfer",
    description=(
        "Dye-transfer colour from old three-strip and two-strip film: "
        "saturated reds, teal-cyans and slightly unreal skin, with the "
        "colour records printed a touch out of register."
    ),
    params=[
        P(
            "process",
            "enum",
            default="three_strip",
            choices=("two_strip", "three_strip"),
            label="Process",
            description="three_strip keeps red, green and blue records. two_strip has only red-orange and cyan-green records, so blues collapse toward cyan-green, as in the 1920s.",
        ),
        P(
            "dye_density",
            "float",
            min=0.0,
            max=2.0,
            default=1.2,
            step=0.05,
            widget="slider",
            label="Dye density",
            description="How heavy the dyes are. Higher gives deeper, more saturated colour and darker shadows; 1 is a plain print and 0 is clear film (white).",
        ),
        P(
            "cross_talk",
            "float",
            min=0.0,
            max=1.0,
            default=0.25,
            step=0.05,
            widget="slider",
            label="Cross-talk",
            description="How much each dye bleeds into its neighbours. Higher softens colour separation and blends hues together; 0 keeps the dyes separate.",
        ),
        P(
            "fringe",
            "float",
            min=0.0,
            max=8.0,
            default=1.5,
            step=0.25,
            widget="slider",
            scale="spatial",
            label="Fringe",
            description="Largest random shift of each colour record, in document pixels. Higher gives wider coloured halos on edges; 0 keeps the records aligned.",
        ),
        P(
            "amount",
            "float",
            min=0.0,
            max=1.0,
            default=0.8,
            step=0.05,
            widget="slider",
            label="Amount",
            description="How much of the effect is mixed in. 0 leaves the image unchanged; 1 is the full dye-transfer result.",
        ),
        P(
            "seed",
            "int",
            min=0,
            max=2**31 - 1,
            default=0,
            step=1,
            label="Seed",
            description="Changes the direction each record shifts without changing the fringe width.",
        ),
    ],
)
def technicolor(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    process = str(params.get("process", "three_strip"))
    density = _clamp(params.get("dye_density", 1.2), 0.0, 2.0, 1.2)
    cross_talk = _clamp(params.get("cross_talk", 0.25), 0.0, 1.0, 0.25)
    fringe = _clamp(params.get("fringe", 1.5), 0.0, 8.0, 1.5)
    amount = _clamp(params.get("amount", 0.8), 0.0, 1.0, 0.8)
    try:
        seed = int(params.get("seed", 0))
    except (TypeError, ValueError):
        seed = 0

    out = img.copy()
    if amount <= 0.0:
        return out

    rgb = img[..., :3].astype(np.float64) / 255.0
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]

    # Offsets are per colour channel; two-strip's red-orange record takes the
    # red offset and its cyan-green record the blue one.
    offsets = _record_offsets(seed, fringe)

    if process == "two_strip":
        wr, wg, wb = _RED_ORANGE_MIX
        rec_red = wr * r + wg * g + wb * b
        wr, wg, wb = _CYAN_GREEN_MIX
        rec_cg = wr * r + wg * g + wb * b
        rec_red = _shift_record(rec_red, *offsets[0])
        rec_cg = _shift_record(rec_cg, *offsets[2])
        records = np.stack([rec_red, rec_cg, rec_cg], axis=-1)
    else:
        records = np.stack(
            [_shift_record(plane, *offsets[i]) for i, plane in enumerate((r, g, b))],
            axis=-1,
        )

    # Record -> dye amount (cyan, magenta, yellow), bleed, then print.
    dyes = 1.0 - records
    dyes = np.clip(dyes @ _cross_talk_matrix(cross_talk).T, 0.0, 1.0)
    printed = (1.0 - dyes) ** density

    blended = rgb + (printed - rgb) * amount
    out[..., :3] = np.clip(np.round(blended * 255.0), 0.0, 255.0).astype(np.uint8)
    return out
