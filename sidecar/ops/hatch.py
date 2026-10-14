"""`hatch` — redraw tone as ink marks: hatched lines, dashes, crosses or
stipple dots whose density follows the image's darkness (epic 18, story 1:
`lines`/`dashes`; story 2 adds `crosses`/`stipple` on the same machinery;
story 3 adds `pen`; story 4 adds `crosses`' `cross_size`/`cross_aspect`;
story 5 annotates the params each pattern ignores with `disabled_when`, so
the panel greys them out rather than letting a moved slider silently do
nothing; story 6 adds `jitter` — `lines`/`dashes` wobble along the stroke
and `crosses` drift within their cell, fading out as a layer closes so
black still closes to solid; story 7 evaluates every lattice-indexed hash
or lookup once per grid cell and gathers it per pixel, for performance —
byte-identical output; story 8 runs the layer loop over row bands on a
thread pool; story 9 gathers by plain fancy indexing rather than
`np.take` and caps the thread pool at 8 workers — the NumPy ceiling).

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
DRAFT/WORKING/BAKED and between differently sized nodes. Since story 7,
every quantity that is a pure function of lattice indices — a hashed
value, `_cell_centre_tone`'s lookup, or the layer-coverage/fade maths that
consume it — is evaluated once on a compact grid spanning the index range
the image actually spans (line index, wavelength cell, or cell-lattice
`(cu, cv)` pair) and **gathered** per pixel by integer offset, rather than
recomputed at every one of an image's pixels; `_hash01` itself is
unchanged, still the pinned hash, and gathering only moves already-
computed values, so output stays byte-identical. Story 8 runs the whole
layer loop over horizontal row bands on a thread pool
(`ops/_bands.py::map_rows`): `t` is computed once, whole, before banding,
and every lattice grid a band builds (wobble, dash phase, stipple hashes,
the crosses sweep's cell grid) is rebuilt over that band's own row range —
the values are unchanged because they are pure functions of the indices,
so this is also byte-identical. `lines` never
calls it on its own account, so it ignores `seed` at `jitter = 0`;
once `jitter > 0` its wobble reads `seed` too (below), so `seed`
carries no `disabled_when` of its own — it is always enabled in the
panel.

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
ignores `seed` at `jitter = 0`; once `jitter > 0` its per-cell offset
(below) reads it too. `cross_size`/`cross_aspect` only shape `crosses`' own
marks, so the panel greys both out for every other `pattern`.

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
no stroke, so the panel greys `pen` out when `pattern` is `stipple`.
`pen` and `cross_size`/`cross_aspect` are orthogonal: `pen`
caps a `crosses` bar's shared half-width (`hw`) only, never its arm
length (`a1`/`a2`), so a low `pen` at a high `cross_size` still draws
long hairline arms.

**`jitter` moves a mark's position, never its angle**, gated by an `if`
so `jitter = 0` takes exactly the pre-story-6 code paths (byte-identical).
It eases off as a layer closes, `fade(c) = clip(2 * (1 - c), 0, 1)` read
on the same coverage `c` the mark already reads, so a closing layer still
lands on its undisturbed, pinned geometry and black still closes to solid
by construction. The maximum displacement is `D = jitter * spacing / 2`,
a ratio like every other length here, so `spacing` stays the only spatial
param. `lines`/`dashes` wobble sideways along a smooth, C¹ 1-D value-noise
wave (`_WOBBLE_WAVELENGTH * spacing` wavelength, smoothstep-interpolated
between hashed lattice values salted 4) rather than a straight per-line
offset; once a line can move off its nominal position, that nominal
nearest line is no longer the only one that can ink a pixel, so the ink
is the union of the three nearest lines (`n0 - 1, n0, n0 + 1`) rather than
just `n0`. `dashes`' along-the-stroke dash phase (`_hash01(m, k, seed)`)
still belongs to each neighbour line `m` individually, so the wobble only
ever moves dashes sideways. `crosses` instead drifts its own mark off its
cell centre (`_hash01` salted 5 and 6) — the tone lookup itself stays at
the nominal, undisplaced cell centre — and `jitter > 0` forces
`_crosses_ink_sweep` even at `cross_size = cross_aspect = 1`: a displaced
mark would otherwise cut off at the cell seam with no neighbour consulted
to fill the gap. `_bar_offsets` gains a `pad` (default `0.0`, so story 4's
own tests and call are untouched) that grows the own cell's half-extent by
`D` in the separating-axis test, so every cell whose *displaced* mark
could reach the pixel stays in the offset set. `stipple` already jitters
its dot and already fades that jitter as it grows, so it ignores `jitter`
outright — the panel greys it out when `pattern` is `stipple`. `lines` and
`crosses` now read `seed` once `jitter > 0`, so `seed` carries no
`disabled_when` of its own — it is always enabled in the panel.

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
`white_is_alpha` shape as `cmyk_halftone`. `paper` does nothing while
`paper_is_alpha` is on, so the panel greys it out then.

**The native kernel** (epic 19, architecture decision 11a). `_coverage_numpy`
above (`_band` + `map_rows`) is the reference and the fallback; when
`oblique_kernels` is importable and `OBLIQUE_KERNELS != "0"`
(`ops._kernels.available()`), `hatch()` instead calls
`_coverage_kernel`, which resolves everything non-numeric (`_build_spec`:
per-layer `cos_t`/`sin_t`, `crosses`' `_cross_geometry` output and
`_bar_offsets` lists) and hands `t` plus that resolved spec to
`oblique_kernels.hatch_coverage` (`sidecar/kernels/src/hatch.rs`) — a fused,
row-parallel Rust loop over the identical per-pixel expressions, at the
identical NumPy NEP 50 float32/float64 precision, as `_band`. The two paths
must produce byte-identical `coverage` arrays (`np.array_equal`) on every
config; `test_hatch.py`'s oracle test checks this directly, and the kernel
docstring records one non-obvious consequence of matching NumPy's own
promotion rules: `crosses` at `layers >= 2` computes (and returns) `coverage`
as `float64`, not `float32`, because `_cross_geometry`'s odd-layer `sqrt2` is
a real `np.float64` scalar rather than a Python float. `hatch.rs`'s module
doc is the fuller account; this paragraph is the pointer to it.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ops import LUMA_B709, LUMA_G709, LUMA_R709, P, _kernels, hex_to_rgb01, op
from ops._bands import map_rows

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

# `jitter`'s `lines`/`dashes` wobble wavelength, as a multiple of `spacing`
# (story 6 doc, "The wave" — don't shorten without redoing that sum).
_WOBBLE_WAVELENGTH = 6.0

# `_hash01` salt for the wobble, distinct from stipple's 1/2/3.
_WOBBLE_SALT = 4

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


def _jitter_fade(c: np.ndarray) -> np.ndarray:
    """`jitter`'s displacement fade, `clip(2 * (1 - c), 0, 1)` on a layer's
    own coverage `c` (story 6 doc, "Fade"): `1` for `c <= 0.5`, `0` at
    `c = 1`, so a closing layer always lands on its undisplaced, pinned
    geometry and black still closes to solid by construction."""
    return np.clip(np.float32(2.0) * (np.float32(1.0) - c), 0.0, 1.0)


def _wobble_prep(u: np.ndarray, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    """The wobble's `u`-only quantities (story 7 doc): the wavelength-cell
    index `i` (`int64`, for hashing) and the smoothstep-interpolated
    fraction within that cell. Identical for every neighbour line `m` a
    pixel's `dn in (-1, 0, 1)` loop visits, so callers hoist this once per
    layer instead of recomputing it three times on 4M-element arrays."""
    wavelength = np.float32(_WOBBLE_WAVELENGTH) * np.float32(spacing)
    x = u / wavelength
    i = np.floor(x)
    frac = x - i
    i_i = i.astype(np.int64)
    smooth = frac * frac * (np.float32(3.0) - np.float32(2.0) * frac)
    return i_i, smooth


def _wobble_setup(
    n0: np.ndarray, u: np.ndarray, spacing: float
) -> tuple[np.ndarray, int, int, np.ndarray, int, int, np.ndarray]:
    """Shared per-layer index-range prep for `lines`/`dashes`' `jitter`
    sweep (story 7 doc): `n0`'s `int64` line index, padded by the three
    `dn in (-1, 0, 1)` neighbours a pixel's loop visits, and `_wobble_prep`'s
    wavelength-cell index/smoothstep, its own range padded by `+1` so one
    grid (`_wobble_grid`) can serve both `g0` (index `i`) and `g1` (index
    `i + 1`). Returns `(n0_i, m_lo, m_hi, i_i, i_lo, i_hi, smooth)`."""
    n0_i = n0.astype(np.int64)
    i_i, smooth = _wobble_prep(u, spacing)
    m_lo, m_hi = int(n0_i.min()) - 1, int(n0_i.max()) + 1
    i_lo, i_hi = int(i_i.min()), int(i_i.max()) + 1
    return n0_i, m_lo, m_hi, i_i, i_lo, i_hi, smooth


def _wobble_grid(
    m_lo: int, m_hi: int, i_lo: int, i_hi: int, k: int, seed: int
) -> tuple[np.ndarray, int]:
    """Hash grid for the wobble's lattice indices (line index `m`,
    wavelength cell `i`), evaluated once over `[m_lo, m_hi] x [i_lo, i_hi]`
    (story 7 doc) rather than per pixel, and returned **raveled** with the
    `i`-axis width `n_i` so `_wobble_gather` can gather by a single flat
    integer index (`grid[idx]`, story 9's plain fancy indexing — 4x faster
    than `np.take` for a 1-D float32 grid with an `intp` index) instead of
    two-array fancy indexing — reading `grid.reshape(-1)[a * n_i + b]` is
    the same C-order memory access as `grid[a, b]`, not a different
    computation, so this changes nothing about the values, only how
    they're fetched. `i_hi` must be at least `i.max() + 1` so the same
    grid gathers both `g0` (index `i`) and `g1` (index `i + 1`) —
    `_hash01` is a pure function of its integer inputs, so gathering an
    already-computed value is bit-identical to hashing it at that pixel
    directly."""
    m_idx = np.arange(m_lo, m_hi + 1, dtype=np.int64)
    i_idx = np.arange(i_lo, i_hi + 1, dtype=np.int64)
    n_i = i_idx.shape[0]
    grid = _hash01(m_idx[:, None], i_idx[None, :], k, seed, _WOBBLE_SALT).astype(
        np.float32
    )
    return grid.reshape(-1), n_i


def _wobble_gather(
    grid: np.ndarray,
    n_i: int,
    m_lo: int,
    i_lo: int,
    m_i: np.ndarray,
    i_i: np.ndarray,
    smooth: np.ndarray,
    disp: np.ndarray,
) -> np.ndarray:
    """`jitter`'s sideways displacement `δ_m` for line index `m_i`, gathered
    from the raveled `grid` (`_wobble_grid`) rather than hashed at this
    pixel (story 7 doc): the same smoothstep interpolation between hashed
    lattice values (story 6 doc, "The wave") as before, with `g0`/`g1` now
    read from the grid at flat index `(m_i - m_lo) * n_i + (i_i - i_lo)`
    (and `+ 1` for `g1`'s `i_i + 1`), scaled by `disp` (`D * fade(c)`,
    already elementwise)."""
    idx = (m_i - np.int64(m_lo)) * np.int64(n_i) + (i_i - np.int64(i_lo))
    g0 = np.float32(2.0) * grid[idx] - np.float32(1.0)
    g1 = np.float32(2.0) * grid[idx + 1] - np.float32(1.0)
    w = g0 + (g1 - g0) * smooth
    return disp * w


def _phase_grid(m_lo: int, m_hi: int, k: int, seed: int) -> np.ndarray:
    """Hash grid for `dashes`' per-line phase `phi`, 1-D over line index
    `m` in `[m_lo, m_hi]` (story 7 doc) — the same `_hash01(m, k, seed)`
    call `dashes` made per pixel, evaluated once and gathered by `m - m_lo`
    instead."""
    m_idx = np.arange(m_lo, m_hi + 1, dtype=np.int64)
    return _hash01(m_idx, k, seed).astype(np.float32)


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


def _cell_indices(
    u: np.ndarray, v: np.ndarray, k: int, spacing: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """`du, dv, cu, cv` only — the lattice-geometry half of `_cell_lattice`,
    with no cell-centre tone lookup. Used by `crosses`' neighbour-sweep path
    (story 7 doc): the sweep gathers every neighbour's tone, including the
    pixel's own cell at offset `(0, 0)`, from its own per-layer grid, so the
    pixel's own-cell tone `_cell_lattice` would compute here is unused —
    skipping it saves a full-size tone read per layer. Identical maths to
    `_cell_lattice`'s own `du, dv, cu, cv`, so callers of either get
    bit-identical results."""
    o_u, o_v = _CELL_OFFSETS[k]
    s = np.float32(spacing)
    cu = np.round(u / s - np.float32(o_u))
    cv = np.round(v / s - np.float32(o_v))

    u_centre = (cu + np.float32(o_u)) * s
    v_centre = (cv + np.float32(o_v)) * s
    du = u - u_centre
    dv = v - v_centre

    return du, dv, cu.astype(np.int64), cv.astype(np.int64)


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
    k: int, bar: int, f: float, pen: float, spacing: float, pad: float = 0.0
) -> list[tuple[int, int]]:
    """Neighbour cell offsets `(di, dj)`, own-cell-relative in lattice
    units, whose `bar`'s (`1` along `p`, `2` along `r`) mark rectangle at
    full growth can reach the own cell — an exact separating-axis test
    between the own cell's square (half-extent `S/2`, grown to `S/2 + pad`
    — story 6 doc, "`crosses`: per-cell offset") and the neighbour's bar
    rectangle (half-length `L = reach * f` along the bar axis, half-width
    `H = max(0, pen * W - 0.5)`), *touching* excluded (story 4 doc,
    "Offset selection"). Pure Python, called once per layer per bar —
    never per pixel. `(0, 0)` is always included. `pad` is `D = jitter *
    spacing / 2`, the own cell's mark's maximum displacement: moving that
    mark anywhere within `[-D, D]²` hits the neighbour's unmoved rectangle
    exactly when the unmoved own cell, grown by `D`, does. `pad = 0.0`
    (the default) is bit-identical to story 4's helper — `s / 2.0 + 0.0`
    and `+ pad` with `pad = 0.0` change nothing."""
    s = spacing
    reach, w_close, _h0, p_dir, r_dir = _cross_geometry(k, s)
    e, n = (p_dir, r_dir) if bar == 1 else (r_dir, p_dir)
    axes = ((1.0, 0.0), (0.0, 1.0), e, n)

    length = reach * f
    half_width = max(0.0, pen * w_close - 0.5)
    r_max = int(np.ceil((length + half_width + pad) / s)) + 1

    offsets: list[tuple[int, int]] = []
    for di in range(-r_max, r_max + 1):
        for dj in range(-r_max, r_max + 1):
            cx, cy = di * s, dj * s
            if all(
                abs(cx * ax + cy * ay)
                < (s / 2.0 + pad) * (abs(ax) + abs(ay))
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
    jitter: float,
    seed: int,
) -> np.ndarray:
    """`crosses`' neighbour sweep, taken when `max(cross_size, cross_size *
    cross_aspect) > 1` or `jitter > 0` (story 4 doc, "Two paths"; story 6
    doc, "`crosses`: per-cell offset"): each bar's ink is the union, over
    every neighbour cell whose bar can reach the pixel's own cell
    (`_bar_offsets`), of that bar drawn *at the neighbour's own*
    cell-centre tone (`_cell_centre_tone`) rather than the pixel's own
    cell's tone. `(0, 0)` is always one of the neighbours, so at `f = 1`
    this is *mathematically* equal to `_crosses_ink` — but not bit-
    identical (`1 - (1 - x)` loses a ULP), so `_crosses_ink` stays the
    single-cell path rather than being replaced by this with a
    single-offset list: that's what keeps `cross_size = cross_aspect = 1`
    byte-identical to the op before this pair existed. `_bar_offsets`'
    pure-Python overhead is a second, smaller reason the hot default path
    skips this. At `jitter > 0`, each neighbour's mark also drifts off its
    own cell centre by `(ju, jv)`, scaled by that neighbour's own fade —
    computed from `c_n`, so it must be known before the displacement is
    applied, matching the gate order the story 6 doc pins. At `jitter = 0`
    this reduces to the pre-story-6 computation exactly (`pad = 0.0`, no
    displacement) — reordering the independent per-neighbour statements
    doesn't change any floating-point result."""
    s = spacing
    o_u, o_v = _CELL_OFFSETS[k]
    reach, w_close, h0, _p_dir, _r_dir = _cross_geometry(k, s)
    f1 = cross_size * cross_aspect
    f2 = cross_size
    sqrt2 = np.float32(np.sqrt(2.0))

    s_f = np.float32(s)
    o_u_f, o_v_f = np.float32(o_u), np.float32(o_v)

    pad = jitter * s / 2.0
    d_disp = np.float32(pad)

    a1_max = reach * f1 + 0.5
    a2_max = reach * f2 + 0.5
    offsets1 = set(_bar_offsets(k, 1, f1, pen, s, pad=pad))
    offsets2 = set(_bar_offsets(k, 2, f2, pen, s, pad=pad))
    # `_bar_offsets` emits `(di, dj)` in ascending lexicographic order, so
    # walking the sorted union keeps each bar's product in its own order —
    # the same floats as evaluating the bars in two separate loops.
    offsets = sorted(offsets1 | offsets2)

    # Story 7: every neighbour's tone/coverage/jitter is a pure function of
    # its own cell-lattice index, so build one grid per layer over the
    # padded index range every offset can reach and gather it per pixel by
    # integer index, instead of recomputing `_cell_centre_tone`/`_c_k`/the
    # jitter hashes at every one of an image's pixels for every neighbour.
    di_lo = min(di for di, _dj in offsets)
    di_hi = max(di for di, _dj in offsets)
    dj_lo = min(dj for _di, dj in offsets)
    dj_hi = max(dj for _di, dj in offsets)

    cu_lo = int(cu.min()) + di_lo
    cu_hi = int(cu.max()) + di_hi
    cv_lo = int(cv.min()) + dj_lo
    cv_hi = int(cv.max()) + dj_hi
    n_v = cv_hi - cv_lo + 1

    cu_idx = np.arange(cu_lo, cu_hi + 1, dtype=np.int64)
    cv_idx = np.arange(cv_lo, cv_hi + 1, dtype=np.int64)
    u_centre_grid = (cu_idx.astype(np.float32)[:, None] + o_u_f) * s_f
    v_centre_grid = (cv_idx.astype(np.float32)[None, :] + o_v_f) * s_f
    t_cell_grid = _cell_centre_tone(u_centre_grid, v_centre_grid, cos_t, sin_t, t, h, w)
    c_n_grid = _c_k(t_cell_grid, k, layers, weight).reshape(-1)

    if jitter > 0.0:
        disp_grid = d_disp * _jitter_fade(c_n_grid)
        h5 = _hash01(cu_idx[:, None], cv_idx[None, :], k, seed, 5).astype(np.float32)
        h6 = _hash01(cu_idx[:, None], cv_idx[None, :], k, seed, 6).astype(np.float32)
        ju_grid = disp_grid * (np.float32(2.0) * h5.reshape(-1) - np.float32(1.0))
        jv_grid = disp_grid * (np.float32(2.0) * h6.reshape(-1) - np.float32(1.0))

    # Own-cell flat index into the grid above, computed once per layer; a
    # neighbour offset `(di, dj)` is then a single scalar shift
    # (`di * n_v + dj`) rather than rebuilding two 4M-element index arrays —
    # the padding above guarantees every shifted index stays in bounds, so
    # the ravelled arithmetic never carries into the wrong row.
    base = (cu - np.int64(cu_lo)) * np.int64(n_v) + (cv - np.int64(cv_lo))

    # One pass over both bars' neighbours, so a neighbour both bars can
    # reach pays for its mark-frame maths once.
    not_bar1 = np.ones_like(du, dtype=np.float32)
    not_bar2 = np.ones_like(du, dtype=np.float32)
    for di, dj in offsets:
        idx = base + np.int64(di) * np.int64(n_v) + np.int64(dj)
        c_n = c_n_grid[idx]

        if jitter > 0.0:
            ju_n = ju_grid[idx]
            jv_n = jv_grid[idx]
            du_n = du - np.float32(di) * s_f - ju_n
            dv_n = dv - np.float32(dj) * s_f - jv_n
        else:
            du_n = du - np.float32(di) * s_f
            dv_n = dv - np.float32(dj) * s_f

        if k % 2 == 0:
            p_n, r_n = du_n, dv_n
        else:
            p_n, r_n = (du_n + dv_n) / sqrt2, (dv_n - du_n) / sqrt2

        if (di, dj) in offsets1:
            not_bar1 = not_bar1 * (
                1.0 - _bar_ink(p_n, r_n, c_n, a1_max, w_close, h0, pen)
            )
        if (di, dj) in offsets2:
            not_bar2 = not_bar2 * (
                1.0 - _bar_ink(r_n, p_n, c_n, a2_max, w_close, h0, pen)
            )

    bar1_union = 1.0 - not_bar1
    bar2_union = 1.0 - not_bar2
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
    appear one at a time), size-led in the dark (dots swell to solid).
    Story 7: `h1`/`h2`/`h3` are each a pure function of the cell index
    `(cu, cv)`, so each is hashed once on a grid over the image's own cell
    range and gathered per pixel, instead of hashed at every pixel."""
    s = spacing
    cu_lo, cu_hi = int(cu.min()), int(cu.max())
    cv_lo, cv_hi = int(cv.min()), int(cv.max())
    cu_idx = np.arange(cu_lo, cu_hi + 1, dtype=np.int64)
    cv_idx = np.arange(cv_lo, cv_hi + 1, dtype=np.int64)
    h1_grid = _hash01(cu_idx[:, None], cv_idx[None, :], k, seed, 1).astype(np.float32)
    h2_grid = _hash01(cu_idx[:, None], cv_idx[None, :], k, seed, 2).astype(np.float32)
    h3_grid = _hash01(cu_idx[:, None], cv_idx[None, :], k, seed, 3).astype(np.float32)
    iu = cu - np.int64(cu_lo)
    iv = cv - np.int64(cv_lo)
    h1 = h1_grid[iu, iv]
    h2 = h2_grid[iu, iv]
    h3 = h3_grid[iu, iv]

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


def _coverage_numpy(
    t: np.ndarray,
    h: int,
    w: int,
    pattern: str,
    layers: int,
    spacing: float,
    angle: float,
    weight: float,
    pen: float,
    cross_size: float,
    cross_aspect: float,
    jitter: float,
    seed: int,
) -> np.ndarray:
    """The NumPy reference and fallback: `_band` (story 8) run over
    `map_rows`'s row bands. Kept exactly as before the kernel path existed —
    the oracle every kernel config is compared against (module docstring,
    "The native kernel")."""
    pen_f = np.float32(pen)
    cell_based = pattern in ("crosses", "stipple")

    def _band(y0: int, y1: int) -> np.ndarray:
        """One horizontal band's layer loop (story 8): `ys, xs` cover only
        this band's rows, `t_band` is this band's own slice of the whole,
        read-only `t` for the per-pixel line/dash tone lookup — but the
        cell-based paths (`_cell_lattice`, `_crosses_ink_sweep`, via
        `_cell_centre_tone`) keep reading the *whole* `t` with the *whole*
        `h`, because a rotated lattice cell centre near a band edge can map
        back to a row outside this band. Every lattice grid built below
        (wobble, dash phase, stipple hashes, the crosses sweep's cell grid)
        is rebuilt over this band's own index range — same values, because
        they are pure functions of the indices (module docstring)."""
        ys, xs = np.mgrid[y0:y1, 0:w].astype(np.float32)
        t_band = t[y0:y1]

        band_coverage = np.zeros((y1 - y0, w), dtype=np.float32)
        for k in range(layers):
            theta_deg = angle if cell_based else angle + _LAYER_ANGLE_OFFSETS[k]
            theta = np.deg2rad(theta_deg)
            cos_t, sin_t = np.float32(np.cos(theta)), np.float32(np.sin(theta))

            u = xs * cos_t + ys * sin_t
            v = -xs * sin_t + ys * cos_t

            if pattern == "crosses":
                if max(cross_size, cross_size * cross_aspect) > 1.0 or jitter > 0.0:
                    # The sweep gathers every neighbour's tone from its own
                    # per-layer grid, including this cell's own `(0, 0)`
                    # offset, so the own-cell tone `_cell_lattice` would look
                    # up here is unused — `_cell_indices` skips that lookup.
                    du, dv, cu, cv = _cell_indices(u, v, k, spacing)
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
                        jitter,
                        seed,
                    )
                else:
                    du, dv, cu, cv, t_cell = _cell_lattice(
                        u, v, k, spacing, cos_t, sin_t, t, h, w
                    )
                    c_k = _c_k(t_cell, k, layers, weight)
                    ink_k = _crosses_ink(
                        du, dv, c_k, k, spacing, pen, cross_size, cross_aspect
                    )
            elif pattern == "stipple":
                du, dv, cu, cv, t_cell = _cell_lattice(
                    u, v, k, spacing, cos_t, sin_t, t, h, w
                )
                c_k = _c_k(t_cell, k, layers, weight)
                ink_k = _stipple_ink(du, dv, c_k, cu, cv, k, seed, spacing)
            elif pattern == "dashes":
                n0 = np.round(v / np.float32(spacing))
                c_k = _c_k(t_band, k, layers, weight)

                a = np.sqrt(c_k)
                across_h = np.minimum(a, pen_f) * np.float32((spacing + 1.0) / 2.0)
                period = np.float32(_DASH_PERIOD * spacing)
                along_h = a * ((period + 1.0) / 2.0)

                if jitter > 0.0:
                    disp = np.float32(jitter * spacing / 2.0) * _jitter_fade(c_k)
                    n0_i, m_lo, m_hi, i_i, i_lo, i_hi, smooth = _wobble_setup(
                        n0, u, spacing
                    )
                    wobble_grid, n_i = _wobble_grid(m_lo, m_hi, i_lo, i_hi, k, seed)
                    phase_grid = _phase_grid(m_lo, m_hi, k, seed)
                    ink_not = np.ones_like(u, dtype=np.float32)
                    for dn in (-1, 0, 1):
                        m_i = n0_i + dn
                        m = n0 + dn
                        delta = _wobble_gather(
                            wobble_grid, n_i, m_lo, i_lo, m_i, i_i, smooth, disp
                        )
                        d_m = np.abs(v - (m * np.float32(spacing) + delta))
                        ink_across = _area(d_m, across_h)

                        phi = phase_grid[m_i - m_lo]
                        e = np.abs(np.mod(u + phi * period, period) - period / 2.0)
                        ink_along = _area(e, along_h)

                        ink_not = ink_not * (1.0 - ink_across * ink_along)
                    ink_k = 1.0 - ink_not
                else:
                    d = np.abs(v - n0 * np.float32(spacing))
                    ink_k = _area(d, across_h)

                    n0_i = n0.astype(np.int64)
                    phase_lo = int(n0_i.min())
                    phase_grid = _phase_grid(phase_lo, int(n0_i.max()), k, seed)
                    phi = phase_grid[n0_i - np.int64(phase_lo)]
                    e = np.abs(np.mod(u + phi * period, period) - period / 2.0)
                    ink_k = ink_k * _area(e, along_h)
            else:
                n0 = np.round(v / np.float32(spacing))
                c_k = _c_k(t_band, k, layers, weight)
                stroke_h = np.minimum(c_k, pen_f) * np.float32((spacing + 1.0) / 2.0)

                if jitter > 0.0:
                    disp = np.float32(jitter * spacing / 2.0) * _jitter_fade(c_k)
                    n0_i, m_lo, m_hi, i_i, i_lo, i_hi, smooth = _wobble_setup(
                        n0, u, spacing
                    )
                    wobble_grid, n_i = _wobble_grid(m_lo, m_hi, i_lo, i_hi, k, seed)
                    ink_not = np.ones_like(u, dtype=np.float32)
                    for dn in (-1, 0, 1):
                        m_i = n0_i + dn
                        m = n0 + dn
                        delta = _wobble_gather(
                            wobble_grid, n_i, m_lo, i_lo, m_i, i_i, smooth, disp
                        )
                        d_m = np.abs(v - (m * np.float32(spacing) + delta))
                        ink_not = ink_not * (1.0 - _area(d_m, stroke_h))
                    ink_k = 1.0 - ink_not
                else:
                    d = np.abs(v - n0 * np.float32(spacing))
                    ink_k = _area(d, stroke_h)

            band_coverage = 1.0 - (1.0 - band_coverage) * (1.0 - ink_k)

        return band_coverage

    return map_rows(h, _band)


def _build_spec(
    pattern: str,
    layers: int,
    spacing: float,
    angle: float,
    weight: float,
    pen: float,
    cross_size: float,
    cross_aspect: float,
    jitter: float,
    seed: int,
) -> dict[str, Any]:
    """The kernel boundary (module docstring, "The native kernel" and
    `hatch-kernel.md`, "The boundary"): everything the Rust loop needs that
    isn't itself per-pixel numeric work — per-layer `cos_t`/`sin_t` (computed
    identically to `_coverage_numpy`'s `_band`), and for `crosses`,
    `_cross_geometry`'s `reach`/`w_close`/`h0` and `_bar_offsets`' neighbour
    lists (`pad` is the same `jitter * spacing / 2.0` `_crosses_ink_sweep`
    computes, needed regardless of whether *this* config ends up taking the
    sweep path — cheap, pure-Python, never per-pixel, so building it
    unconditionally for `crosses` keeps this function's shape simple)."""
    cell_based = pattern in ("crosses", "stipple")
    layer_specs: list[dict[str, Any]] = []
    for k in range(layers):
        theta_deg = angle if cell_based else angle + _LAYER_ANGLE_OFFSETS[k]
        theta = np.deg2rad(theta_deg)
        cos_t, sin_t = np.float32(np.cos(theta)), np.float32(np.sin(theta))
        layer: dict[str, Any] = {
            "cos_t": float(cos_t),
            "sin_t": float(sin_t),
            "reach": 0.0,
            "w_close": 0.0,
            "h0": 0.0,
            "offsets1": [],
            "offsets2": [],
        }
        if pattern == "crosses":
            reach, w_close, h0, _p_dir, _r_dir = _cross_geometry(k, spacing)
            f1 = cross_size * cross_aspect
            f2 = cross_size
            pad = jitter * spacing / 2.0
            layer["reach"] = float(reach)
            layer["w_close"] = float(w_close)
            layer["h0"] = float(h0)
            layer["offsets1"] = _bar_offsets(k, 1, f1, pen, spacing, pad=pad)
            layer["offsets2"] = _bar_offsets(k, 2, f2, pen, spacing, pad=pad)
        layer_specs.append(layer)

    return {
        "pattern": pattern,
        "layers": layers,
        "spacing": float(spacing),
        "weight": float(weight),
        "pen": float(pen),
        "cross_size": float(cross_size),
        "cross_aspect": float(cross_aspect),
        "jitter": float(jitter),
        "seed": int(seed),
        "layer": layer_specs,
    }


def _coverage_kernel(
    t: np.ndarray,
    h: int,
    w: int,
    pattern: str,
    layers: int,
    spacing: float,
    angle: float,
    weight: float,
    pen: float,
    cross_size: float,
    cross_aspect: float,
    jitter: float,
    seed: int,
) -> np.ndarray:
    """The native path: `_build_spec` resolves the boundary, then
    `oblique_kernels.hatch_coverage` runs the fused Rust loop. Returns
    `float32` for every pattern except `crosses` at `layers >= 2`, which the
    reference itself computes in `float64` (module docstring, "The native
    kernel") — `hatch()` doesn't care which, the blend below upconverts
    either way."""
    spec = _build_spec(
        pattern,
        layers,
        spacing,
        angle,
        weight,
        pen,
        cross_size,
        cross_aspect,
        jitter,
        seed,
    )
    kernels = _kernels.require()
    return kernels.hatch_coverage(t, spec)


def _coverage(
    t: np.ndarray,
    h: int,
    w: int,
    pattern: str,
    layers: int,
    spacing: float,
    angle: float,
    weight: float,
    pen: float,
    cross_size: float,
    cross_aspect: float,
    jitter: float,
    seed: int,
    *,
    use_kernel: bool,
) -> np.ndarray:
    """Path selection (module docstring, "The native kernel"): kernel when
    available and not disabled (`OBLIQUE_KERNELS=0`), NumPy otherwise. A
    thin dispatcher so tests can force either path directly."""
    args = (
        t,
        h,
        w,
        pattern,
        layers,
        spacing,
        angle,
        weight,
        pen,
        cross_size,
        cross_aspect,
        jitter,
        seed,
    )
    if use_kernel:
        return _coverage_kernel(*args)
    return _coverage_numpy(*args)


@op(
    "hatch",
    category="print",
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
            label="Pattern",
            description="Mark style: lines, dashes, crosses or stipple dots, with density following the image's darkness.",
        ),
        P(
            "layers",
            "int",
            min=1,
            max=4,
            default=2,
            step=1,
            widget="slider",
            label="Layers",
            description="Number of crossing mark families, 1 to 4. More layers build darker tones by crosshatching; 1 varies stroke width instead.",
        ),
        P(
            "spacing",
            "float",
            min=2.0,
            max=96.0,
            default=8.0,
            step=0.5,
            scale="spatial",
            label="Spacing",
            description="Distance between marks in document pixels. Larger is coarser.",
        ),
        P(
            "angle",
            "float",
            min=0.0,
            max=180.0,
            default=45.0,
            step=1.0,
            label="Angle",
            description="Rotation of the marks in degrees.",
        ),
        P(
            "weight",
            "float",
            min=0.05,
            max=1.0,
            default=1.0,
            step=0.01,
            label="Weight",
            description="Overall ink coverage. Lower is lighter; 1 lets black close to solid.",
        ),
        P(
            "pen",
            "float",
            min=0.01,
            max=1.0,
            default=1.0,
            step=0.01,
            disabled_when={"path": "pattern", "equals": "stipple"},
            label="Pen width",
            description="Widest a stroke may get, as a fraction of a full-width stroke. Lower draws finer lines; below 1, black no longer fills solid.",
        ),
        P(
            "jitter",
            "float",
            min=0.0,
            max=1.0,
            default=0.0,
            step=0.01,
            disabled_when={"path": "pattern", "equals": "stipple"},
            label="Jitter",
            description="How far marks wander from their regular position, as a fraction of spacing. 0 is perfectly regular.",
        ),
        P(
            "cross_size",
            "float",
            min=0.25,
            max=3.0,
            default=1.0,
            step=0.05,
            disabled_when={"path": "pattern", "notEquals": "crosses"},
            label="Cross size",
            description="Arm length of each cross relative to its cell. Larger arms reach into neighbouring cells.",
        ),
        P(
            "cross_aspect",
            "float",
            min=1.0,
            max=4.0,
            default=1.0,
            step=0.05,
            disabled_when={"path": "pattern", "notEquals": "crosses"},
            label="Cross aspect",
            description="Stretches one arm of each cross longer than the other. 1 keeps them equal.",
        ),
        P(
            "source",
            "enum",
            default="luma",
            choices=("luma", "red", "green", "blue"),
            label="Tone source",
            description="What the marks follow: luma (overall brightness), or only the red, green or blue channel.",
        ),
        P(
            "black",
            "float",
            min=0.0,
            max=255.0,
            default=0.0,
            step=1.0,
            label="Black point",
            description="Input value, 0 to 255, treated as full darkness. Raising it puts more ink in the shadows.",
        ),
        P(
            "white",
            "float",
            min=0.0,
            max=255.0,
            default=255.0,
            step=1.0,
            label="White point",
            description="Input value, 0 to 255, treated as full lightness. Lowering it clears more of the highlights.",
        ),
        P(
            "gamma",
            "float",
            min=0.1,
            max=5.0,
            default=1.0,
            step=0.05,
            label="Gamma",
            description="Tone curve for the marks. Above 1 lightens the midtones, so fewer marks; below 1 darkens them.",
        ),
        P(
            "ink",
            "color",
            default="#000000",
            label="Ink colour",
            description="Colour of the marks.",
        ),
        P(
            "paper",
            "color",
            default="#ffffff",
            disabled_when={"path": "paper_is_alpha", "equals": True},
            label="Paper colour",
            description="Colour between the marks. Not used when Paper is transparent is on.",
        ),
        P(
            "paper_is_alpha",
            "bool",
            default=False,
            label="Paper is transparent",
            description="Makes the area between marks transparent so they overprint the layers below.",
        ),
        P(
            "seed",
            "int",
            min=0,
            max=2**31 - 1,
            default=0,
            step=1,
            label="Seed",
            description="Changes the random pattern without changing its character.",
        ),
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
    cross_size = max(0.25, min(3.0, float(params.get("cross_size", 1.0))))
    cross_aspect = max(1.0, min(4.0, float(params.get("cross_aspect", 1.0))))
    jitter = max(0.0, min(1.0, float(params.get("jitter", 0.0))))
    seed = int(params.get("seed", 0))

    t = _tone(img, params)
    coverage = _coverage(
        t,
        h,
        w,
        pattern,
        layers,
        spacing,
        angle,
        weight,
        pen,
        cross_size,
        cross_aspect,
        jitter,
        seed,
        use_kernel=_kernels.available(),
    )

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
