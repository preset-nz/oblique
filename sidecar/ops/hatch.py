"""`hatch` — redraw tone as ink marks: hatched lines, dashes, crosses or
stipple dots whose density follows the image's darkness (epic 18, story 1:
`lines`/`dashes`; story 2 adds `crosses`/`stipple` on the same machinery;
story 3 adds `pen`; story 4 adds `crosses`' `cross_size`/`cross_aspect`).

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
along its own length. The cell-centre tone lookup itself — map the centre
back to image space, round, clip to bounds, read `t` — is factored into
`_cell_centre_tone`, shared by `_cell_lattice`'s own-cell tone and, for
`crosses`' neighbour sweep below, every neighbour cell it visits. The
lattice rotates by `angle` only — cell patterns carry no per-layer angle
offset (`crosses` puts its orientation in the mark instead) — and layer
`k` shifts the lattice by a per-layer offset in cell units, `((0, 0), (½,
½), (½, 0), (0, ½))[k]`, so successive layers don't stack on the same
cell seams. Only a pixel's own cell is evaluated for `stipple`, and for
`crosses` at default arm sizes; neighbouring cells at different tones
meet at a visible seam, the same trade-off `cmyk_halftone` makes.

`crosses` draws a `+` (layers 0, 2) or `×` (layers 1, 3): the union of two
perpendicular bars, each bar a product of two `_area` calls (one across,
one along), with geometry constants (`A_max`, `W`, `h0`, one place per
orientation, `_cross_geometry`) pinned 2026-09-16 so every pixel in a cell
is covered by at least one full-length arm before either bar starts
thickening — the no-pinhole closure. `cross_size` is bar2's (the `r`-axis
bar's) arm-length factor and `cross_aspect` multiplies bar1's (the
`p`-axis bar's) factor on top of it — `f1 = cross_size * cross_aspect`,
`f2 = cross_size` — so raising `cross_aspect` only ever stretches one bar
longer, never shrinks the other, pinned 2026-09-17 (story 4 doc,
"Geometry"). At `f1 = f2 = 1` a pixel evaluates only its own cell
(`_crosses_ink`, bit-identical to the op before this pair existed,
`reach * 1.0 == reach`). Past `max(f1, f2) = 1` an arm can bleed past its
own cell's edge, so each bar instead unions its own cell's mark with
every neighbouring cell's mark that can reach it (`_crosses_ink_sweep`),
each neighbour drawn at *its own* cell-centre tone rather than the
pixel's — which neighbours can reach is an exact separating-axis test
against the bar's rectangle, worked out once per layer per bar rather
than per pixel (`_bar_offsets`, story 4 doc, "Offset selection"). Both
`_crosses_ink` and the sweep share one bar's growth/pen-cap maths
(`_bar_ink`) so the pinned formula lives in exactly one place. `crosses`
ignores `seed`.

**`pen` is the widest a stroke gets**, as a fraction of the width that
closes to solid ink (`(spacing + 1) / 2` half-width for `lines`/`dashes`,
`W` for a `crosses` bar). A stroke grows with tone as above until it
reaches the pen, then holds, so a low `pen` draws hairlines and tone keeps
building through `layers` crossing over each other (and, for `crosses`,
arm length). It is a cap, not a scale: `weight` scales every layer's
coverage down, where `pen` leaves the light tones alone and only stops the
dark ones from fattening. `pen = 1` is exactly the uncapped op; below 1,
black no longer closes to solid. A ratio rather than pixels, so
`spacing` stays the only spatial param. `stipple` ignores it — a dot has
no stroke.

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


def _cell_centre_tone(
    u_centre: np.ndarray,
    v_centre: np.ndarray,
    cos_t: np.floating,
    sin_t: np.floating,
    t: np.ndarray,
    h: int,
    w: int,
) -> np.ndarray:
    """Tone read at a lattice cell centre (`u_centre, v_centre`, rotated
    frame): mapped back to image space, rounded and clipped to bounds —
    the same cell-centre lookup `_screen_channel` (`cmyk_halftone.py`)
    uses. Shared by `_cell_lattice`'s own-cell tone (`crosses`/`stipple`)
    and, for `crosses` past `cross_size`/`cross_aspect` = 1, every
    neighbour cell the bar sweep visits (`_crosses_ink_sweep`, story 4) —
    factored out so both read the identical lookup rather than risking
    drift between an own-cell and a neighbour-cell copy."""
    cx = u_centre * cos_t - v_centre * sin_t
    cy = u_centre * sin_t + v_centre * cos_t
    ix = np.clip(np.round(cx), 0, w - 1).astype(np.intp)
    iy = np.clip(np.round(cy), 0, h - 1).astype(np.intp)
    return t[iy, ix]


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
    the tone at the cell centre (`_cell_centre_tone`)."""
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

    t_cell = _cell_centre_tone(u_centre, v_centre, cos_t, sin_t, t, h, w)

    return du, dv, cu.astype(np.int64), cv.astype(np.int64), t_cell


def _cross_geometry(
    k: int, spacing: float
) -> tuple[float, float, float, tuple[float, float], tuple[float, float]]:
    """`crosses`' per-orientation geometry, one place so `+`'s and `×`'s
    constants (pinned 2026-09-16, story 2 doc) are never re-derived or
    copied: `(reach, w_close, h0, p_dir, r_dir)`. `reach` is the arm's
    unscaled half-length, `w_close` the closing half-width `W`, `h0` the
    minimum bar half-width; `p_dir`/`r_dir` are unit vectors along the
    mark frame's `p`/`r` axes in `(du, dv)` space, used by the offsets
    helper's separating-axis test (story 4 doc, "Offset selection")."""
    s = spacing
    if k % 2 == 0:
        reach, w_close = s / 2.0, s / 2.0 + 0.5
        p_dir, r_dir = (1.0, 0.0), (0.0, 1.0)
    else:
        sqrt2 = np.sqrt(2.0)
        reach, w_close = s / sqrt2, s / (2.0 * sqrt2) + 0.5
        p_dir, r_dir = (1.0 / sqrt2, 1.0 / sqrt2), (-1.0 / sqrt2, 1.0 / sqrt2)
    h0 = max(0.5, 0.075 * s)
    return reach, w_close, h0, p_dir, r_dir


def _bar_ink(
    along: np.ndarray,
    across: np.ndarray,
    c: np.ndarray,
    a_max: float,
    w_close: float,
    h0: float,
    pen: float,
) -> np.ndarray:
    """One `crosses` bar's ink at coverage `c`: an `_area` box-filter along
    its own axis (half-length `a`, growing from `0` to `a_max`) times
    another across its width (half-width `hw`, capped at `pen * w_close`
    — story 3, unchanged). Shared by the single-cell path (`_crosses_ink`)
    and every neighbour the sweep visits (`_crosses_ink_sweep`, story 4)
    — the growth/pen-cap maths pinned in both docs lives here exactly
    once."""
    phase1 = c <= 0.5
    a = np.where(phase1, a_max * (c / 0.5), a_max)
    hw = np.where(phase1, h0, h0 + (w_close - h0) * ((c - 0.5) / 0.5))
    hw = np.minimum(hw, pen * w_close)
    return _area(np.abs(across), hw) * _area(np.abs(along), a)


def _bar_offsets(
    k: int, bar: int, f: float, pen: float, spacing: float
) -> list[tuple[int, int]]:
    """Neighbour cell offsets `(di, dj)`, own-cell-relative in lattice
    units, whose `bar`'s (`1` along `p`, `2` along `r`) mark rectangle at
    full growth can reach the own cell — an exact separating-axis test
    between the own cell's square (half-extent `S/2`) and the neighbour's
    bar rectangle (half-length `L = reach * f` along the bar axis,
    half-width `H = max(0, pen * W - 0.5)`), *touching* excluded (story 4
    doc, "Offset selection"). Pure Python, called once per layer per bar
    — never per pixel. `(0, 0)` is always included."""
    s = spacing
    reach, w_close, _h0, p_dir, r_dir = _cross_geometry(k, s)
    e, n = (p_dir, r_dir) if bar == 1 else (r_dir, p_dir)
    axes = ((1.0, 0.0), (0.0, 1.0), e, n)

    length = reach * f
    half_width = max(0.0, pen * w_close - 0.5)
    r_max = int(np.ceil((length + half_width) / s)) + 1

    offsets: list[tuple[int, int]] = []
    for di in range(-r_max, r_max + 1):
        for dj in range(-r_max, r_max + 1):
            cx, cy = di * s, dj * s
            if all(
                abs(cx * ax + cy * ay)
                < s / 2.0 * (abs(ax) + abs(ay))
                + length * abs(e[0] * ax + e[1] * ay)
                + half_width * abs(n[0] * ax + n[1] * ay)
                - 1e-9
                for ax, ay in axes
            ):
                offsets.append((di, dj))
    return offsets


def _crosses_ink(
    du: np.ndarray,
    dv: np.ndarray,
    c: np.ndarray,
    k: int,
    spacing: float,
    pen: float,
    cross_size: float,
    cross_aspect: float,
) -> np.ndarray:
    """`crosses`' single-cell ink: a `+` (k = 0, 2) or `×` (k = 1, 3), the
    union of two perpendicular `_area` bars, each pixel evaluating only
    its own cell. Geometry constants and growth are pinned 2026-09-16
    (story 2 doc, "crosses"); `cross_size`/`cross_aspect` scale each bar's
    arm-length maximum independently, pinned 2026-09-17 (story 4 doc,
    "Geometry") — do not re-derive either. `pen` caps the shared bar
    half-width at a fraction of the closing width (story 3), so arms
    still reach full length while the bars stay hairlines. Only the path
    taken when `max(cross_size, cross_size * cross_aspect) <= 1` — past
    that an arm can reach past its own cell and `_crosses_ink_sweep`
    takes over. At `cross_size = cross_aspect = 1` this is bit-identical
    to the op before this pair existed (`reach * 1.0 == reach`)."""
    reach, w_close, h0, _p_dir, _r_dir = _cross_geometry(k, spacing)
    if k % 2 == 0:
        p, r = du, dv
    else:
        sqrt2 = np.sqrt(2.0)
        p, r = (du + dv) / sqrt2, (dv - du) / sqrt2

    f1 = cross_size * cross_aspect  # bar1, along p
    f2 = cross_size  # bar2, along r

    bar1 = _bar_ink(p, r, c, reach * f1 + 0.5, w_close, h0, pen)
    bar2 = _bar_ink(r, p, c, reach * f2 + 0.5, w_close, h0, pen)
    return 1.0 - (1.0 - bar1) * (1.0 - bar2)


def _crosses_ink_sweep(
    cu: np.ndarray,
    cv: np.ndarray,
    du: np.ndarray,
    dv: np.ndarray,
    k: int,
    spacing: float,
    pen: float,
    cross_size: float,
    cross_aspect: float,
    cos_t: np.floating,
    sin_t: np.floating,
    t: np.ndarray,
    h: int,
    w: int,
    layers: int,
    weight: float,
) -> np.ndarray:
    """`crosses`' neighbour sweep, taken when `max(cross_size, cross_size *
    cross_aspect) > 1` (story 4 doc, "Two paths"): each bar's ink is the
    union, over every neighbour cell whose bar can reach the pixel's own
    cell (`_bar_offsets`), of that bar drawn *at the neighbour's own*
    cell-centre tone (`_cell_centre_tone`) rather than the pixel's own
    cell's tone. `(0, 0)` is always one of the neighbours, so this
    subsumes the single-cell case; it isn't used there only because
    `_bar_offsets` is pure-Python overhead the hot default path doesn't
    need."""
    s = spacing
    o_u, o_v = _CELL_OFFSETS[k]
    reach, w_close, h0, _p_dir, _r_dir = _cross_geometry(k, s)
    f1 = cross_size * cross_aspect
    f2 = cross_size
    sqrt2 = np.float32(np.sqrt(2.0))

    cu_f = cu.astype(np.float32)
    cv_f = cv.astype(np.float32)
    s_f = np.float32(s)
    o_u_f, o_v_f = np.float32(o_u), np.float32(o_v)

    def bar_union(bar: int, f: float, a_max: float) -> np.ndarray:
        not_bar = np.ones_like(du, dtype=np.float32)
        for di, dj in _bar_offsets(k, bar, f, pen, s):
            du_n = du - np.float32(di) * s_f
            dv_n = dv - np.float32(dj) * s_f
            if k % 2 == 0:
                p_n, r_n = du_n, dv_n
            else:
                p_n, r_n = (du_n + dv_n) / sqrt2, (dv_n - du_n) / sqrt2

            u_centre_n = (cu_f + np.float32(di) + o_u_f) * s_f
            v_centre_n = (cv_f + np.float32(dj) + o_v_f) * s_f
            t_cell_n = _cell_centre_tone(u_centre_n, v_centre_n, cos_t, sin_t, t, h, w)
            c_n = _c_k(t_cell_n, k, layers, weight)

            along, across = (p_n, r_n) if bar == 1 else (r_n, p_n)
            not_bar = not_bar * (
                1.0 - _bar_ink(along, across, c_n, a_max, w_close, h0, pen)
            )
        return 1.0 - not_bar

    bar1_union = bar_union(1, f1, reach * f1 + 0.5)
    bar2_union = bar_union(2, f2, reach * f2 + 0.5)
    return 1.0 - (1.0 - bar1_union) * (1.0 - bar2_union)


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
        P("pen", "float", min=0.01, max=1.0, default=1.0, step=0.01),
        P("cross_size", "float", min=0.25, max=3.0, default=1.0, step=0.05),
        P("cross_aspect", "float", min=1.0, max=4.0, default=1.0, step=0.05),
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
    pen = max(0.0, min(1.0, float(params.get("pen", 1.0))))
    pen_f = np.float32(pen)
    cross_size = max(0.25, min(3.0, float(params.get("cross_size", 1.0))))
    cross_aspect = max(1.0, min(4.0, float(params.get("cross_aspect", 1.0))))
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
            du, dv, cu, cv, t_cell = _cell_lattice(
                u, v, k, spacing, cos_t, sin_t, t, h, w
            )
            if max(cross_size, cross_size * cross_aspect) <= 1.0:
                c_k = _c_k(t_cell, k, layers, weight)
                ink_k = _crosses_ink(
                    du, dv, c_k, k, spacing, pen, cross_size, cross_aspect
                )
            else:
                ink_k = _crosses_ink_sweep(
                    cu,
                    cv,
                    du,
                    dv,
                    k,
                    spacing,
                    pen,
                    cross_size,
                    cross_aspect,
                    cos_t,
                    sin_t,
                    t,
                    h,
                    w,
                    layers,
                    weight,
                )
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
            across_h = np.minimum(a, pen_f) * np.float32((spacing + 1.0) / 2.0)
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

            stroke_h = np.minimum(c_k, pen_f) * np.float32((spacing + 1.0) / 2.0)
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
