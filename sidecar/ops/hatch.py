"""`hatch` — redraw tone as ink marks: hatched lines, dashes, crosses or
stipple dots whose density follows the image's darkness (epic 18, story 1:
`lines`/`dashes`; story 2 adds `crosses`/`stipple` on the same machinery).

**Tone.** `source` picks a 0..1 channel — `luma` via the shared
`LUMA_R709`/`LUMA_G709`/`LUMA_B709` weights, or a single `red`/`green`/
`blue` channel — then the same `black`/`white`/`gamma` remap as the
`levels` op (`white <= black` guards to `black + 1`) turns it into `v`
(lightness). `t = 1 - v` (darkness) is what every layer reads from here
on.

**Layers — the tone model.** `layers` (1..4) splits the tone range into
that many equal bands; layer `k` (0-based) grows its marks from nothing
across band `k`. `q = 1 - layers**(-1/(layers-1))` caps every layer but
the last, so the first `layers - 1` layers, treated as independent
crossing families, together cover roughly `(layers-1)/layers`; the last
layer is allowed to close to solid, carrying tone to full ink at `t = 1`.
`layers = 1` degenerates to a single width-modulated family (engraving);
`layers = 4` is classic stacking crosshatch. `_c_k` is this model as a
small reusable helper: `lines`/`dashes` evaluate it on the per-pixel tone;
`crosses`/`stipple` evaluate it on a per-cell tone lookup (below). Layers
combine as an ink union (`K = 1 - prod(1 - ink_k)`).

**`lines` and `dashes` are continuous strokes**, worked out in rotated
per-layer coordinates (`u` along the stroke, `v` across it, both a pure
function of the pixel's own `(x, y)` — no per-image centring, so a mark's
position never depends on image size). Layer `k`'s angle is
`angle + (0, 90, 45, 135)[k]` degrees. There is **no Python loop except
over `layers`**; every per-pixel field is `float32` (four `float64`
layers at 4K is a lot of memory for no visible gain).

**Anti-aliasing** is an *exact* 1-D box-filter overlap area (`_area`)
between a 1 px pixel and a stroke of half-width `h` — not a smoothstep,
which would leave ghost ink at zero width and pinholes at full width.
`_area` is exactly 0 at `h = 0` (white stays white) and, once a stroke's
half-width carries its +0.5 px overdrive (`c * (spacing + 1) / 2` — one
stroke per period otherwise can't close the half pixel that belongs to
the neighbouring stroke), exactly 1 across the whole period at full
coverage (black closes to solid ink, no pinholes).

`dashes` breaks the stroke into dashes whose gap closes as it darkens —
coverage splits evenly between stroke width and dash duty, phase-shifted
per line by `_hash01` so it isn't a static picket fence. `_hash01` is a
**stateless** integer hash (a splitmix64 finaliser, vectorised over any
number of `int64`-reinterpreted-as-`uint64` arrays/scalars), not a
`default_rng` table indexed by line number — a table's contents depend on
how many lines the image spans, so dash phases would shift between
DRAFT/WORKING/BAKED and between differently sized nodes. `lines` never
calls it and so ignores `seed` outright.

**`crosses` and `stipple` are cell-based** (`_cell_lattice`, the same
shape as `_screen_channel` in `cmyk_halftone.py`): one whole mark per
lattice cell, tone sampled once at the cell centre rather than per pixel,
so a mark is whole and sized to its cell's tone rather than thickening
along its own length. The lattice rotates by `angle` only — cell patterns
carry no per-layer angle offset (`crosses` puts its orientation in the
mark instead) — and layer `k` shifts the lattice by a per-layer offset in
cell units, `((0, 0), (½, ½), (½, 0), (0, ½))[k]`, so successive layers
don't stack on the same cell seams. Only a pixel's own cell is evaluated;
neighbouring cells at different tones meet at a visible seam, the same
trade-off `cmyk_halftone` makes.

`crosses` draws a `+` (layers 0, 2) or `×` (layers 1, 3): the union of two
perpendicular bars, each bar a product of two `_area` calls (one across,
one along), with geometry constants (`A_max`, `W`, `h0`) pinned 2026-09-16
so every pixel in a cell is covered by at least one full-length arm before
either bar starts thickening — the no-pinhole closure. `crosses` ignores
`seed`.

`stipple` draws one jittered, anti-aliased disc per cell, born once
`c_k` crosses a per-cell seeded threshold (`_hash01` salted 1) and then
growing in radius (light tones are density-led: dots appear one at a
time) until every cell's dot has merged into solid ink (dark tones are
size-led). The dot's centre jitters within its cell (`_hash01` salted 2
and 3) so it never lines up into a regular screen. `stipple` uses `seed`.

**Output.** Colours parse via `hex_to_rgb01`, falling back to their own
default on a garbage string. `paper_is_alpha=False` (default) paints
`paper*(1-K) + ink*K` into RGB and leaves alpha exactly as the input's;
`=True` paints `ink` everywhere and multiplies alpha by `K`, so the paper
becomes transparent and the marks overprint the layers below — the same
`white_is_alpha` shape as `cmyk_halftone`.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, hex_to_rgb01, op

# Layer k's angle offset from the `angle` param, degrees, for the
# continuous-stroke patterns (`lines`/`dashes`). Two layers give a
# perpendicular crosshatch; three and four add the diagonals. Cell
# patterns (`crosses`/`stipple`) don't use this table — they rotate by
# `angle` only and carry per-layer variation in the lattice offset and,
# for `crosses`, the mark orientation instead.
_LAYER_ANGLE_OFFSETS = (0.0, 90.0, 45.0, 135.0)

# `dashes`' along-line dash period, as a multiple of `spacing`.
_DASH_PERIOD = 3.0

# Layer k's lattice offset, in cell units, for the cell-based patterns
# (`crosses`/`stipple`). Keeps successive layers off the same cell seams.
_CELL_OFFSETS = ((0.0, 0.0), (0.5, 0.5), (0.5, 0.0), (0.0, 0.5))

# `stipple`'s birth threshold, as a fraction of full coverage: a cell's
# dot is born once its layer coverage `c` reaches `_STIPPLE_BIRTH * h1`.
_STIPPLE_BIRTH = 0.25

_SPLITMIX_INC = np.uint64(0x9E3779B97F4A7C15)


def _splitmix64_mix(z: np.ndarray) -> np.ndarray:
    """The splitmix64 finaliser: a fixed, stateless avalanche from a 64-bit
    state to a well-mixed 64-bit output. Vectorised — `z` is any shape of
    `uint64`."""
    z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    z = z ^ (z >> np.uint64(31))
    return z


def _hash01(*ints: Any) -> np.ndarray:
    """Stateless hash of any number of integer arrays/scalars -> float in
    [0, 1). Each input is reinterpreted `int64 -> uint64` (bit pattern, not
    clipped, so negative line/cell indices from rotation hash cleanly),
    folded one at a time into a running splitmix64 state. The result
    depends only on the packed integers themselves — never on array shape
    or how many lines/cells an image spans — unlike a `default_rng` table
    indexed by line number, so phases can't shift between cook levels or
    differently sized nodes."""
    state = np.uint64(0)
    for value in ints:
        x = np.asarray(value, dtype=np.int64).view(np.uint64)
        state = _splitmix64_mix(state + x + _SPLITMIX_INC)
    return (state >> np.uint64(11)).astype(np.float64) * (1.0 / (1 << 53))


def _area(d: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Exact 1-D box-filter overlap area between a 1 px pixel centred a
    distance `d` from a stroke's centreline and the stroke's half-width
    `h`. Elementwise; `d` and `h` broadcast together. Zero at `h = 0`; a
    half-width of `(period + 1) / 2` covers the whole period exactly."""
    return np.clip(np.minimum(d + 0.5, h) - np.maximum(d - 0.5, -h), 0.0, 1.0)


def _c_k(t: np.ndarray, k: int, layers: int, weight: float) -> np.ndarray:
    """Layer `k`'s mark coverage in [0, 1] at tone `t` (darkness): the
    shared layer tone model (module docstring, "Layers"). `t` may be the
    per-pixel tone (`lines`/`dashes`) or a per-pixel array of cell-centre
    tone lookups (`crosses`/`stipple`) — the maths is the same either
    way."""
    ramp_k = np.clip(t * layers - k, 0.0, 1.0)
    q = 1.0 - layers ** (-1.0 / (layers - 1)) if layers >= 2 else 1.0
    q_k = q if k < layers - 1 else 1.0
    return np.float32(weight * q_k) * ramp_k


def _tone(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    """RGB -> darkness `t` in [0, 1]: `source` channel, then the `levels`
    op's `black`/`white`/`gamma` remap. `float32` throughout."""
    source = str(params.get("source", "luma"))
    rgb01 = img[..., :3].astype(np.float32) / 255.0

    if source == "red":
        src01 = rgb01[..., 0]
    elif source == "green":
        src01 = rgb01[..., 1]
    elif source == "blue":
        src01 = rgb01[..., 2]
    else:
        src01 = (
            rgb01[..., 0] * np.float32(LUMA_R709)
            + rgb01[..., 1] * np.float32(LUMA_G709)
            + rgb01[..., 2] * np.float32(LUMA_B709)
        )

    black = float(params.get("black", 0.0))
    white = float(params.get("white", 255.0))
    gamma = float(params.get("gamma", 1.0))
    if white <= black:
        white = black + 1.0

    src255 = src01 * np.float32(255.0)
    v = np.clip((src255 - np.float32(black)) / np.float32(white - black), 0.0, 1.0)
    v = np.power(v, np.float32(1.0 / gamma))
    return 1.0 - v


def _cell_lattice(
    u: np.ndarray,
    v: np.ndarray,
    k: int,
    spacing: float,
    cos_t: np.floating,
    sin_t: np.floating,
    t: np.ndarray,
    h: int,
    w: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Lattice for cell-based patterns (`crosses`/`stipple`), layer `k`:
    `u, v` are the pixel's rotated coordinates (rotation shared across
    layers — cell patterns carry no per-layer angle offset). Returns
    `(du, dv, cu, cv, t_cell)`: `du, dv` are the pixel's offset from its
    cell centre in the rotated frame (`|du|, |dv| <= S/2`); `cu, cv` are
    the cell's integer lattice indices (`int64`, for hashing); `t_cell` is
    the tone read at the cell centre, mapped back to image space, rounded
    and clipped to bounds — the same cell-centre lookup `_screen_channel`
    (`cmyk_halftone.py`) uses."""
    o_u, o_v = _CELL_OFFSETS[k]
    s = np.float32(spacing)
    cu = np.round(u / s - np.float32(o_u))
    cv = np.round(v / s - np.float32(o_v))

    # Cell centre in the rotated frame, shared by `du`/`dv` and the
    # image-space lookup below — a single source so the two can't drift
    # apart.
    u_centre = (cu + np.float32(o_u)) * s
    v_centre = (cv + np.float32(o_v)) * s
    du = u - u_centre
    dv = v - v_centre

    cx = u_centre * cos_t - v_centre * sin_t
    cy = u_centre * sin_t + v_centre * cos_t
    ix = np.clip(np.round(cx), 0, w - 1).astype(np.intp)
    iy = np.clip(np.round(cy), 0, h - 1).astype(np.intp)
    t_cell = t[iy, ix]

    return du, dv, cu.astype(np.int64), cv.astype(np.int64), t_cell


def _crosses_ink(
    du: np.ndarray, dv: np.ndarray, c: np.ndarray, k: int, spacing: float
) -> np.ndarray:
    """`crosses`' per-layer ink: a `+` (k = 0, 2) or `×` (k = 1, 3), the
    union of two perpendicular `_area` bars. Geometry constants and growth
    are pinned 2026-09-16 (story 2 doc, "crosses") — do not re-derive."""
    s = spacing
    if k % 2 == 0:
        p, r = du, dv
        reach, w_close = s / 2.0, s / 2.0 + 0.5
    else:
        sqrt2 = np.sqrt(2.0)
        p, r = (du + dv) / sqrt2, (dv - du) / sqrt2
        reach, w_close = s / sqrt2, s / (2.0 * sqrt2) + 0.5

    a_max = reach + 0.5
    h0 = max(0.5, 0.075 * s)

    phase1 = c <= 0.5
    a = np.where(phase1, a_max * (c / 0.5), a_max)
    hw = np.where(phase1, h0, h0 + (w_close - h0) * ((c - 0.5) / 0.5))

    bar1 = _area(np.abs(r), hw) * _area(np.abs(p), a)
    bar2 = _area(np.abs(p), hw) * _area(np.abs(r), a)
    return 1.0 - (1.0 - bar1) * (1.0 - bar2)


def _stipple_ink(
    du: np.ndarray,
    dv: np.ndarray,
    c: np.ndarray,
    cu: np.ndarray,
    cv: np.ndarray,
    k: int,
    seed: int,
    spacing: float,
) -> np.ndarray:
    """`stipple`'s per-layer ink: one jittered, anti-aliased disc per cell,
    born at a per-cell seeded threshold and growing until it closes the
    cell (story 2 doc, "stipple"). Density-led in the light tones (dots
    appear one at a time), size-led in the dark (dots swell to solid)."""
    s = spacing
    h1 = _hash01(cu, cv, k, seed, 1).astype(np.float32)
    h2 = _hash01(cu, cv, k, seed, 2).astype(np.float32)
    h3 = _hash01(cu, cv, k, seed, 3).astype(np.float32)

    birth = np.float32(_STIPPLE_BIRTH)
    beta = birth * h1
    r0 = np.float32(max(0.75, 0.12 * s))
    r_close = np.float32(s / np.sqrt(2.0) + 0.5)

    r = np.where(
        c < beta,
        np.float32(0.0),
        np.where(
            c <= birth,
            r0,
            r0 + (r_close - r0) * (c - birth) / (np.float32(1.0) - birth),
        ),
    )

    j = np.maximum(np.float32(0.0), np.float32(s / 2.0) - r)
    jx = (h2 - np.float32(0.5)) * np.float32(2.0) * j
    jy = (h3 - np.float32(0.5)) * np.float32(2.0) * j
    dist = np.hypot(du - jx, dv - jy)

    return np.where(r <= 0.0, 0.0, np.clip(r - dist + 0.5, 0.0, 1.0))


@op(
    "hatch",
    label="Hatch",
    description=(
        "Redraw tone as pen marks — hatched lines, dashes, crosses or "
        "stipple dots whose density follows the image's darkness. Layers "
        "stack crosshatch; one layer engraves."
    ),
    params=[
        P(
            "pattern",
            "enum",
            default="lines",
            choices=("lines", "dashes", "crosses", "stipple"),
        ),
        P("layers", "int", min=1, max=4, default=2, step=1),
        P(
            "spacing",
            "float",
            min=2.0,
            max=96.0,
            default=8.0,
            step=0.5,
            scale="spatial",
        ),
        P("angle", "float", min=0.0, max=180.0, default=45.0, step=1.0),
        P("weight", "float", min=0.05, max=1.0, default=1.0, step=0.01),
        P(
            "source",
            "enum",
            default="luma",
            choices=("luma", "red", "green", "blue"),
        ),
        P("black", "float", min=0.0, max=255.0, default=0.0, step=1.0),
        P("white", "float", min=0.0, max=255.0, default=255.0, step=1.0),
        P("gamma", "float", min=0.1, max=5.0, default=1.0, step=0.05),
        P("ink", "color", default="#000000"),
        P("paper", "color", default="#ffffff"),
        P("paper_is_alpha", "bool", default=False),
        P("seed", "int", min=0, max=2**31 - 1, default=0, step=1),
    ],
    writes_alpha=True,
)
def hatch(img: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    h, w = img.shape[:2]
    pattern = str(params.get("pattern", "lines"))
    layers = max(1, min(4, int(params.get("layers", 2))))
    spacing = max(1.0, float(params.get("spacing", 8.0)))
    angle = float(params.get("angle", 45.0))
    weight = float(params.get("weight", 1.0))
    seed = int(params.get("seed", 0))

    t = _tone(img, params)
    cell_based = pattern in ("crosses", "stipple")

    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)

    coverage = np.zeros((h, w), dtype=np.float32)
    for k in range(layers):
        theta_deg = angle if cell_based else angle + _LAYER_ANGLE_OFFSETS[k]
        theta = np.deg2rad(theta_deg)
        cos_t, sin_t = np.float32(np.cos(theta)), np.float32(np.sin(theta))

        u = xs * cos_t + ys * sin_t
        v = -xs * sin_t + ys * cos_t

        if pattern == "crosses":
            du, dv, _cu, _cv, t_cell = _cell_lattice(
                u, v, k, spacing, cos_t, sin_t, t, h, w
            )
            c_k = _c_k(t_cell, k, layers, weight)
            ink_k = _crosses_ink(du, dv, c_k, k, spacing)
        elif pattern == "stipple":
            du, dv, cu, cv, t_cell = _cell_lattice(
                u, v, k, spacing, cos_t, sin_t, t, h, w
            )
            c_k = _c_k(t_cell, k, layers, weight)
            ink_k = _stipple_ink(du, dv, c_k, cu, cv, k, seed, spacing)
        elif pattern == "dashes":
            n = np.round(v / np.float32(spacing))
            d = np.abs(v - n * np.float32(spacing))
            c_k = _c_k(t, k, layers, weight)

            a = np.sqrt(c_k)
            across_h = a * np.float32((spacing + 1.0) / 2.0)
            ink_k = _area(d, across_h)

            period = np.float32(_DASH_PERIOD * spacing)
            phi = _hash01(n.astype(np.int64), k, seed).astype(np.float32)
            e = np.abs(np.mod(u + phi * period, period) - period / 2.0)
            along_h = a * ((period + 1.0) / 2.0)
            ink_k = ink_k * _area(e, along_h)
        else:
            n = np.round(v / np.float32(spacing))
            d = np.abs(v - n * np.float32(spacing))
            c_k = _c_k(t, k, layers, weight)

            stroke_h = c_k * np.float32((spacing + 1.0) / 2.0)
            ink_k = _area(d, stroke_h)

        coverage = 1.0 - (1.0 - coverage) * (1.0 - ink_k)

    ink_rgb = np.array(hex_to_rgb01(params.get("ink", "#000000"), (0.0, 0.0, 0.0)))
    paper_rgb = np.array(hex_to_rgb01(params.get("paper", "#ffffff"), (1.0, 1.0, 1.0)))
    paper_is_alpha = bool(params.get("paper_is_alpha", False))

    out = img.copy()

    if paper_is_alpha:
        out[..., :3] = np.clip(np.round(ink_rgb * 255.0), 0.0, 255.0).astype(np.uint8)
        in_alpha = img[..., 3].astype(np.float64) / 255.0
        out_alpha = in_alpha * coverage
        out[..., 3] = np.clip(np.round(out_alpha * 255.0), 0.0, 255.0).astype(np.uint8)
    else:
        k3 = coverage[..., None].astype(np.float64)
        rgb = paper_rgb * (1.0 - k3) + ink_rgb * k3
        out[..., :3] = np.clip(np.round(rgb * 255.0), 0.0, 255.0).astype(np.uint8)

    return out
