//! `hatch`'s per-band layer loop as a fused Rust kernel (Epic 19 story 2).
//!
//! Reference: `sidecar/ops/hatch.py`'s module docstring and `_band` — this
//! file replicates that maths, expression by expression, at the exact
//! float32/float64 precision NumPy's NEP 50 type-promotion rules give the
//! reference. Byte-identity with that reference (`np.array_equal`) is the
//! acceptance bar (architecture decision 11a), not speed.
//!
//! **The boundary.** Python (`ops/hatch.py::_build_spec`) resolves
//! everything non-numeric before calling in: per-layer `cos_t`/`sin_t`
//! (already `np.float32`), `crosses`' per-layer `reach`/`w_close`/`h0`
//! (`_cross_geometry`) and neighbour offset lists (`_bar_offsets`). This
//! kernel receives `t` (the whole tone map) and that resolved `spec`; it
//! never parses params or re-derives `_bar_offsets`.
//!
//! **A NumPy dtype surprise the port had to match**: `_cross_geometry`
//! returns `np.float64` scalars for odd layer indices (`k % 2 == 1`, the
//! `×`-oriented layers) because its `sqrt2 = np.sqrt(2.0)` there is a real
//! `np.float64` scalar — NEP 50 *strong*, unlike the plain Python floats
//! the even-`k` branch produces. That forces every `crosses` layer whose
//! index is odd to compute (and its ink to be promoted to) `float64`, and
//! once `hatch`'s `band_coverage` accumulator has been touched by a
//! `float64` layer it stays `float64` for the rest of the union — so
//! `crosses` at `layers == 1` returns `float32` coverage and `layers >= 2`
//! (which always includes `k = 1`) returns `float64`. This kernel
//! reproduces that exactly and returns whichever dtype the reference would
//! (`hatch_coverage`'s Python-visible return type is `float32` **or**
//! `float64` array depending on the config — see the story's shipped note
//! for why the story's stated `-> float32` signature had to flex).
//!
//! Every other pattern (`lines`, `dashes`, `stipple`) and `crosses` at
//! `layers == 1` stay `float32` throughout, matching the reference.

use std::collections::{BTreeSet, HashSet};

use numpy::ndarray::Array2;
use numpy::{IntoPyArray, PyReadonlyArray2};
use pyo3::exceptions::PyKeyError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use rayon::prelude::*;

// --- constants (mirrors module-level constants in `ops/hatch.py`) ---------

const CELL_OFFSETS: [(f32, f32); 4] = [(0.0, 0.0), (0.5, 0.5), (0.5, 0.0), (0.0, 0.5)];
const WOBBLE_WAVELENGTH: f32 = 6.0;
const DASH_PERIOD: f64 = 3.0;
const STIPPLE_BIRTH: f32 = 0.25;
const SPLITMIX_INC: u64 = 0x9E3779B97F4A7C15;

// --- `_hash01` / splitmix64 -------------------------------------------------

#[inline]
fn splitmix64_mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

/// `_hash01`: stateless hash of any number of `int64`-reinterpreted-as-
/// `uint64` values -> float in `[0, 1)`. Returns `f64` (the reference's own
/// return dtype, `.astype(np.float64)` before the final scale); callers cast
/// to `f32` at the exact point the reference does (`.astype(np.float32)` on
/// the grid it would have gathered from — mathematically the same value,
/// since gathering an already-computed value is bit-identical to hashing it
/// at that pixel directly, per the module docstring's story 7 argument).
#[inline]
fn hash01(ints: &[i64]) -> f64 {
    let mut state: u64 = 0;
    for &v in ints {
        let x = v as u64; // bit-reinterpret, matches `.view(np.uint64)`
        state = splitmix64_mix(state.wrapping_add(x).wrapping_add(SPLITMIX_INC));
    }
    ((state >> 11) as f64) * (1.0f64 / (1u64 << 53) as f64)
}

// --- `_area` (three precision variants — see hatch-kernel.md's dtype trace) -

/// Pure-`f32` `_area`: both `d` and `h` are real `float32` arrays in the
/// reference (lines/dashes/stipple/crosses-even).
#[inline]
fn area32(d: f32, h: f32) -> f32 {
    let hi = (d + 0.5).min(h);
    let lo = (d - 0.5).max(-h);
    (hi - lo).max(0.0).min(1.0)
}

/// Pure-`f64` `_area`: both operands already real `float64` (crosses'
/// single-cell odd-`k` path, where the rotation itself was computed in
/// `f64`).
#[inline]
fn area_f64(d: f64, h: f64) -> f64 {
    let hi = (d + 0.5).min(h);
    let lo = (d - 0.5).max(-h);
    (hi - lo).max(0.0).min(1.0)
}

/// Mixed-precision `_area`: `d` is a real `float32` value (computed and
/// rounded in `f32`, exactly as the reference's `abs(across)`/`abs(along)`
/// on a real `float32` array), widened to `f64` only where NumPy's
/// `np.minimum`/`np.maximum` promote it against the real `float64` array
/// `h` — crosses' sweep path at odd `k`, where the rotation stays `f32`
/// (its own local `sqrt2` is `np.float32`) but `w_close`/`a_max` are the
/// `float64`-strong scalars `_cross_geometry` produces for odd `k`.
#[inline]
fn area_mixed(d: f32, h: f64) -> f64 {
    let hi = ((d + 0.5) as f64).min(h);
    let lo = ((d - 0.5) as f64).max(-h);
    (hi - lo).max(0.0).min(1.0)
}

// --- `_c_k` / `_jitter_fade` -------------------------------------------------

/// `_c_k`: always returns `float32` in the reference (`np.float32(weight *
/// q_k) * ramp_k`) regardless of `weight`/`layers`' own types, because the
/// scalar factor is explicitly cast before the multiply.
#[inline]
fn c_k(t_val: f32, k: usize, layers: usize, weight: f64) -> f32 {
    let ramp_k = (t_val * (layers as f32) - (k as f32)).max(0.0).min(1.0);
    let q: f64 = if layers >= 2 {
        1.0 - (layers as f64).powf(-1.0 / ((layers - 1) as f64))
    } else {
        1.0
    };
    let q_k: f64 = if k < layers.saturating_sub(1) { q } else { 1.0 };
    ((weight * q_k) as f32) * ramp_k
}

#[inline]
fn jitter_fade(c: f32) -> f32 {
    (2.0f32 * (1.0f32 - c)).max(0.0).min(1.0)
}

#[inline]
fn mod_f32(a: f32, p: f32) -> f32 {
    let r = a % p;
    if r != 0.0 && (r < 0.0) != (p < 0.0) {
        r + p
    } else {
        r
    }
}

// --- cell lattice (`_cell_indices` / `_cell_lattice` / `_cell_centre_tone`) -

#[inline]
fn cell_centre_tone(
    u_centre: f32,
    v_centre: f32,
    cos_t: f32,
    sin_t: f32,
    t: &[f32],
    h: usize,
    w: usize,
) -> f32 {
    let cx = u_centre * cos_t - v_centre * sin_t;
    let cy = u_centre * sin_t + v_centre * cos_t;
    let ix = cx.round_ties_even().max(0.0).min((w - 1) as f32) as usize;
    let iy = cy.round_ties_even().max(0.0).min((h - 1) as f32) as usize;
    t[iy * w + ix]
}

/// `du, dv, cu, cv` only — mirrors `_cell_indices`.
#[inline]
fn cell_indices(u: f32, v: f32, o_u: f32, o_v: f32, s: f32) -> (f32, f32, i64, i64) {
    let cu_f = (u / s - o_u).round_ties_even();
    let cv_f = (v / s - o_v).round_ties_even();
    let u_centre = (cu_f + o_u) * s;
    let v_centre = (cv_f + o_v) * s;
    (u - u_centre, v - v_centre, cu_f as i64, cv_f as i64)
}

/// `du, dv, cu, cv, t_cell` — mirrors `_cell_lattice`.
#[inline]
#[allow(clippy::too_many_arguments)]
fn cell_lattice(
    u: f32,
    v: f32,
    o_u: f32,
    o_v: f32,
    s: f32,
    cos_t: f32,
    sin_t: f32,
    t: &[f32],
    h: usize,
    w: usize,
) -> (f32, f32, i64, i64, f32) {
    let cu_f = (u / s - o_u).round_ties_even();
    let cv_f = (v / s - o_v).round_ties_even();
    let u_centre = (cu_f + o_u) * s;
    let v_centre = (cv_f + o_v) * s;
    let du = u - u_centre;
    let dv = v - v_centre;
    let t_cell = cell_centre_tone(u_centre, v_centre, cos_t, sin_t, t, h, w);
    (du, dv, cu_f as i64, cv_f as i64, t_cell)
}

// --- `_bar_ink` (three precision variants, matching `_area`'s) -------------

/// `a_max` is a single pre-combined value (`reach * f + 0.5`, computed by
/// the caller) that touches the array directly in one multiply, so casting
/// it to `f32` once, before that multiply, matches the reference's NEP 50
/// promotion exactly. `w_close`/`h0`/`pen` stay `f64`: the reference computes
/// `w_close - h0` and `pen * w_close` as *pure-Python* expressions — both
/// operands weak scalars, no array involved — at full `f64` precision
/// first, and only that already-combined value is cast to `f32` once, where
/// it then meets the array (`np.where`'s else-branch multiply,
/// `np.minimum`). Casting `w_close`/`h0`/`pen` to `f32` individually before
/// combining them is a different (and wrong) computation — two roundings
/// where the reference has one.
#[inline]
#[allow(clippy::too_many_arguments)]
fn bar_ink_f32(
    along: f32,
    across: f32,
    c: f32,
    a_max: f32,
    w_close: f64,
    h0: f64,
    pen: f64,
) -> f32 {
    let phase1 = c <= 0.5;
    let a = if phase1 { a_max * (c / 0.5) } else { a_max };
    let hw = if phase1 {
        h0 as f32
    } else {
        (h0 as f32) + ((w_close - h0) as f32) * ((c - 0.5) / 0.5)
    };
    let hw = hw.min((pen * w_close) as f32);
    area32(across.abs(), hw) * area32(along.abs(), a)
}

/// Crosses' single-cell odd-`k` path: `along`/`across` are already real
/// `float64` (the rotation itself ran in `f64`, matching `_cross_geometry`'s
/// `np.float64`-strong `sqrt2`); `c` stays `float32` (the reference's `c_k`
/// is always `float32`, and `c / 0.5`, `c - 0.5` run in `f32` before the
/// promoting multiply by the `float64`-strong `a_max`/`w_close - h0`).
#[inline]
#[allow(clippy::too_many_arguments)]
fn bar_ink_full64(
    along: f64,
    across: f64,
    c: f32,
    a_max: f64,
    w_close: f64,
    h0: f64,
    pen: f64,
) -> f64 {
    let phase1 = c <= 0.5;
    let c_over = c / 0.5;
    let a: f64 = if phase1 {
        a_max * (c_over as f64)
    } else {
        a_max
    };
    let c_minus = (c - 0.5) / 0.5;
    let hw: f64 = if phase1 {
        h0
    } else {
        h0 + (w_close - h0) * (c_minus as f64)
    };
    let hw = hw.min(pen * w_close);
    area_f64(across.abs(), hw) * area_f64(along.abs(), a)
}

/// Crosses' sweep odd-`k` path: `along`/`across` stay `float32` (the
/// sweep's own local `sqrt2` is `np.float32`-explicit), `c` is `float32`;
/// `a_max`/`w_close`/`h0`/`pen` are the `float64`-strong scalars the
/// reference's `_bar_offsets`/`_cross_geometry` carry for odd `k`.
#[inline]
#[allow(clippy::too_many_arguments)]
fn bar_ink_mixed(
    along: f32,
    across: f32,
    c: f32,
    a_max: f64,
    w_close: f64,
    h0: f64,
    pen: f64,
) -> f64 {
    let phase1 = c <= 0.5;
    let c_over = c / 0.5;
    let a: f64 = if phase1 {
        a_max * (c_over as f64)
    } else {
        a_max
    };
    let c_minus = (c - 0.5) / 0.5;
    let hw: f64 = if phase1 {
        h0
    } else {
        h0 + (w_close - h0) * (c_minus as f64)
    };
    let hw = hw.min(pen * w_close);
    area_mixed(across.abs(), hw) * area_mixed(along.abs(), a)
}

// --- `lines` / `dashes` -----------------------------------------------------

#[inline]
#[allow(clippy::too_many_arguments)]
fn lines_ink(
    u: f32,
    v: f32,
    t_val: f32,
    k: usize,
    layers: usize,
    spacing: f64,
    weight: f64,
    pen_f32: f32,
    jitter: f64,
    wobble: Option<&LineWobbleCache>,
) -> f32 {
    let spacing_f32 = spacing as f32;
    let n0 = (v / spacing_f32).round_ties_even();
    let c_val = c_k(t_val, k, layers, weight);
    let stroke_h = c_val.min(pen_f32) * (((spacing + 1.0) / 2.0) as f32);

    if jitter > 0.0 {
        let wobble = wobble.expect("wobble cache built whenever jitter > 0");
        let disp = ((jitter * spacing / 2.0) as f32) * jitter_fade(c_val);
        let wavelength = WOBBLE_WAVELENGTH * spacing_f32;
        let x = u / wavelength;
        let i_f = x.floor();
        let frac = x - i_f;
        let i_i = i_f as i64;
        let smooth = frac * frac * (3.0f32 - 2.0f32 * frac);
        let n0_i = n0 as i64;

        let mut ink_not = 1.0f32;
        for dn in -1i64..=1 {
            let m_i = n0_i + dn;
            let m = n0 + (dn as f32);
            let delta = wobble_gather(wobble, m_i, i_i, smooth, disp);
            let d_m = (v - (m * spacing_f32 + delta)).abs();
            ink_not *= 1.0 - area32(d_m, stroke_h);
        }
        1.0 - ink_not
    } else {
        let d = (v - n0 * spacing_f32).abs();
        area32(d, stroke_h)
    }
}

#[inline]
#[allow(clippy::too_many_arguments)]
fn dashes_ink(
    u: f32,
    v: f32,
    t_val: f32,
    k: usize,
    layers: usize,
    spacing: f64,
    weight: f64,
    pen_f32: f32,
    jitter: f64,
    wobble: Option<&LineWobbleCache>,
    phase: &PhaseCache,
) -> f32 {
    let spacing_f32 = spacing as f32;
    let n0 = (v / spacing_f32).round_ties_even();
    let c_val = c_k(t_val, k, layers, weight);
    let a = c_val.sqrt();
    let across_h = a.min(pen_f32) * (((spacing + 1.0) / 2.0) as f32);
    let period = (DASH_PERIOD * spacing) as f32;
    let along_h = a * ((period + 1.0f32) / 2.0f32);

    if jitter > 0.0 {
        let wobble = wobble.expect("wobble cache built whenever jitter > 0");
        let disp = ((jitter * spacing / 2.0) as f32) * jitter_fade(c_val);
        let wavelength = WOBBLE_WAVELENGTH * spacing_f32;
        let x = u / wavelength;
        let i_f = x.floor();
        let frac = x - i_f;
        let i_i = i_f as i64;
        let smooth = frac * frac * (3.0f32 - 2.0f32 * frac);
        let n0_i = n0 as i64;

        let mut ink_not = 1.0f32;
        for dn in -1i64..=1 {
            let m_i = n0_i + dn;
            let m = n0 + (dn as f32);
            let delta = wobble_gather(wobble, m_i, i_i, smooth, disp);
            let d_m = (v - (m * spacing_f32 + delta)).abs();
            let ink_across = area32(d_m, across_h);

            let phi = phase_gather(phase, m_i);
            let e = (mod_f32(u + phi * period, period) - period / 2.0f32).abs();
            let ink_along = area32(e, along_h);

            ink_not *= 1.0 - ink_across * ink_along;
        }
        1.0 - ink_not
    } else {
        let d = (v - n0 * spacing_f32).abs();
        let ink_k = area32(d, across_h);

        let n0_i = n0 as i64;
        let phi = phase_gather(phase, n0_i);
        let e = (mod_f32(u + phi * period, period) - period / 2.0f32).abs();
        ink_k * area32(e, along_h)
    }
}

// --- `stipple` ---------------------------------------------------------------

#[inline]
#[allow(clippy::too_many_arguments)]
fn stipple_ink(
    du: f32,
    dv: f32,
    c: f32,
    cu: i64,
    cv: i64,
    k: usize,
    seed: i64,
    spacing: f64,
) -> f32 {
    let h1 = hash01(&[cu, cv, k as i64, seed, 1]) as f32;
    let h2 = hash01(&[cu, cv, k as i64, seed, 2]) as f32;
    let h3 = hash01(&[cu, cv, k as i64, seed, 3]) as f32;

    let birth = STIPPLE_BIRTH;
    let beta = birth * h1;
    let r0 = (0.75f64.max(0.12 * spacing)) as f32;
    let r_close = ((spacing / 2.0f64.sqrt()) + 0.5) as f32;

    let r = if c < beta {
        0.0f32
    } else if c <= birth {
        r0
    } else {
        r0 + (r_close - r0) * (c - birth) / (1.0f32 - birth)
    };

    let j = 0.0f32.max(((spacing / 2.0) as f32) - r);
    let jx = (h2 - 0.5f32) * 2.0f32 * j;
    let jy = (h3 - 0.5f32) * 2.0f32 * j;
    let dist = (du - jx).hypot(dv - jy);

    if r <= 0.0 {
        0.0
    } else {
        (r - dist + 0.5).max(0.0).min(1.0)
    }
}

// --- `crosses` ---------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn crosses_layer_even(
    u: f32,
    v: f32,
    cos_t: f32,
    sin_t: f32,
    k: usize,
    spec: &Spec,
    layer: &LayerSpec,
    t: &[f32],
    h: usize,
    w: usize,
    cache: Option<&CrossesCache>,
) -> f32 {
    let s = spec.spacing as f32;
    let o = CELL_OFFSETS[k];
    let f1 = spec.cross_size * spec.cross_aspect;
    let f2 = spec.cross_size;
    let a1_max = layer.reach * f1 + 0.5;
    let a2_max = layer.reach * f2 + 0.5;
    let sweep = f1.max(f2) > 1.0 || spec.jitter > 0.0;

    if !sweep {
        let (du, dv, _cu, _cv, t_cell) = cell_lattice(u, v, o.0, o.1, s, cos_t, sin_t, t, h, w);
        let c_val = c_k(t_cell, k, spec.layers, spec.weight);
        let a1_max32 = a1_max as f32;
        let a2_max32 = a2_max as f32;
        let bar1 = bar_ink_f32(du, dv, c_val, a1_max32, layer.w_close, layer.h0, spec.pen);
        let bar2 = bar_ink_f32(dv, du, c_val, a2_max32, layer.w_close, layer.h0, spec.pen);
        1.0 - (1.0 - bar1) * (1.0 - bar2)
    } else {
        let cache = cache.expect("crosses cache built whenever the sweep path is taken");
        crosses_sweep_even(u, v, k, spec, layer, a1_max, a2_max, cache)
    }
}

#[allow(clippy::too_many_arguments)]
fn crosses_layer_odd(
    u: f32,
    v: f32,
    cos_t: f32,
    sin_t: f32,
    k: usize,
    spec: &Spec,
    layer: &LayerSpec,
    t: &[f32],
    h: usize,
    w: usize,
    cache: Option<&CrossesCache>,
) -> f64 {
    let s = spec.spacing as f32;
    let o = CELL_OFFSETS[k];
    let f1 = spec.cross_size * spec.cross_aspect;
    let f2 = spec.cross_size;
    let a1_max = layer.reach * f1 + 0.5;
    let a2_max = layer.reach * f2 + 0.5;
    let sweep = f1.max(f2) > 1.0 || spec.jitter > 0.0;

    if !sweep {
        let (du, dv, _cu, _cv, t_cell) = cell_lattice(u, v, o.0, o.1, s, cos_t, sin_t, t, h, w);
        let c_val = c_k(t_cell, k, spec.layers, spec.weight);
        let sqrt2 = 2.0f64.sqrt();
        let sum = du + dv; // real f32 addition, rounded, exactly as the reference
        let diff = dv - du;
        let p = (sum as f64) / sqrt2;
        let r = (diff as f64) / sqrt2;
        let bar1 = bar_ink_full64(p, r, c_val, a1_max, layer.w_close, layer.h0, spec.pen);
        let bar2 = bar_ink_full64(r, p, c_val, a2_max, layer.w_close, layer.h0, spec.pen);
        1.0 - (1.0 - bar1) * (1.0 - bar2)
    } else {
        let cache = cache.expect("crosses cache built whenever the sweep path is taken");
        crosses_sweep_odd(u, v, k, spec, layer, a1_max, a2_max, cache)
    }
}

fn crosses_sweep_even(
    u: f32,
    v: f32,
    k: usize,
    spec: &Spec,
    layer: &LayerSpec,
    a1_max: f64,
    a2_max: f64,
    cache: &CrossesCache,
) -> f32 {
    let s = spec.spacing as f32;
    let o = CELL_OFFSETS[k];
    let (du, dv, cu, cv) = cell_indices(u, v, o.0, o.1, s);
    let a1_max32 = a1_max as f32;
    let a2_max32 = a2_max as f32;

    let mut not_bar1 = 1.0f32;
    let mut not_bar2 = 1.0f32;
    for &(di, dj, in1, in2) in &layer.offsets {
        let cu_n = cu + di;
        let cv_n = cv + dj;
        let (c_n, ju_n, jv_n) = crosses_cache_gather(cache, cu_n, cv_n, spec.jitter);

        let du_n = du - (di as f32) * s - ju_n;
        let dv_n = dv - (dj as f32) * s - jv_n;

        if in1 {
            not_bar1 *=
                1.0 - bar_ink_f32(du_n, dv_n, c_n, a1_max32, layer.w_close, layer.h0, spec.pen);
        }
        if in2 {
            not_bar2 *=
                1.0 - bar_ink_f32(dv_n, du_n, c_n, a2_max32, layer.w_close, layer.h0, spec.pen);
        }
    }

    let bar1_union = 1.0 - not_bar1;
    let bar2_union = 1.0 - not_bar2;
    1.0 - (1.0 - bar1_union) * (1.0 - bar2_union)
}

fn crosses_sweep_odd(
    u: f32,
    v: f32,
    k: usize,
    spec: &Spec,
    layer: &LayerSpec,
    a1_max: f64,
    a2_max: f64,
    cache: &CrossesCache,
) -> f64 {
    let s = spec.spacing as f32;
    let o = CELL_OFFSETS[k];
    let (du, dv, cu, cv) = cell_indices(u, v, o.0, o.1, s);
    let w_close = layer.w_close;
    let h0 = layer.h0;
    let pen = spec.pen;
    let sqrt2_f32 = 2.0f64.sqrt() as f32; // sweep's own local sqrt2 is np.float32-explicit

    let mut not_bar1 = 1.0f64;
    let mut not_bar2 = 1.0f64;
    for &(di, dj, in1, in2) in &layer.offsets {
        let cu_n = cu + di;
        let cv_n = cv + dj;
        let (c_n, ju_n, jv_n) = crosses_cache_gather(cache, cu_n, cv_n, spec.jitter);

        let du_n = du - (di as f32) * s - ju_n;
        let dv_n = dv - (dj as f32) * s - jv_n;
        let sum = du_n + dv_n;
        let diff = dv_n - du_n;
        let p_n = sum / sqrt2_f32;
        let r_n = diff / sqrt2_f32;

        if in1 {
            not_bar1 *= 1.0 - bar_ink_mixed(p_n, r_n, c_n, a1_max, w_close, h0, pen);
        }
        if in2 {
            not_bar2 *= 1.0 - bar_ink_mixed(r_n, p_n, c_n, a2_max, w_close, h0, pen);
        }
    }

    let bar1_union = 1.0 - not_bar1;
    let bar2_union = 1.0 - not_bar2;
    1.0 - (1.0 - bar1_union) * (1.0 - bar2_union)
}

// --- spec ---------------------------------------------------------------

enum Pattern {
    Lines,
    Dashes,
    Crosses,
    Stipple,
}

struct LayerSpec {
    cos_t: f32,
    sin_t: f32,
    reach: f64,
    w_close: f64,
    h0: f64,
    /// `(di, dj, in_offsets1, in_offsets2)`, sorted lexicographically by
    /// `(di, dj)` — the sorted `offsets1 | offsets2` union the reference's
    /// `_crosses_ink_sweep` walks, with membership precomputed once here
    /// rather than re-hashed (`HashSet::contains`) at every pixel/offset in
    /// the hot loop.
    offsets: Vec<(i64, i64, bool, bool)>,
}

struct Spec {
    pattern: Pattern,
    layers: usize,
    spacing: f64,
    weight: f64,
    pen: f64,
    cross_size: f64,
    cross_aspect: f64,
    jitter: f64,
    seed: i64,
    layer: Vec<LayerSpec>,
}

fn dict_get<'py>(d: &Bound<'py, PyDict>, key: &str) -> PyResult<Bound<'py, PyAny>> {
    d.get_item(key)?
        .ok_or_else(|| PyKeyError::new_err(key.to_string()))
}

impl Spec {
    fn parse(d: &Bound<'_, PyDict>) -> PyResult<Spec> {
        let pattern_str: String = dict_get(d, "pattern")?.extract()?;
        let pattern = match pattern_str.as_str() {
            "lines" => Pattern::Lines,
            "dashes" => Pattern::Dashes,
            "crosses" => Pattern::Crosses,
            "stipple" => Pattern::Stipple,
            other => {
                return Err(PyKeyError::new_err(format!(
                    "unknown hatch pattern: {other}"
                )));
            }
        };
        let layers: usize = dict_get(d, "layers")?.extract()?;
        let spacing: f64 = dict_get(d, "spacing")?.extract()?;
        let weight: f64 = dict_get(d, "weight")?.extract()?;
        let pen: f64 = dict_get(d, "pen")?.extract()?;
        let cross_size: f64 = dict_get(d, "cross_size")?.extract()?;
        let cross_aspect: f64 = dict_get(d, "cross_aspect")?.extract()?;
        let jitter: f64 = dict_get(d, "jitter")?.extract()?;
        let seed: i64 = dict_get(d, "seed")?.extract()?;

        let layer_list = dict_get(d, "layer")?;
        let layer_list = layer_list.cast::<PyList>()?;
        let mut layer = Vec::with_capacity(layer_list.len());
        for item in layer_list.iter() {
            let ld = item.cast::<PyDict>()?;
            let cos_t: f32 = dict_get(ld, "cos_t")?.extract()?;
            let sin_t: f32 = dict_get(ld, "sin_t")?.extract()?;
            let reach: f64 = dict_get(ld, "reach")?.extract()?;
            let w_close: f64 = dict_get(ld, "w_close")?.extract()?;
            let h0: f64 = dict_get(ld, "h0")?.extract()?;
            let offsets1: Vec<(i64, i64)> = dict_get(ld, "offsets1")?.extract()?;
            let offsets2: Vec<(i64, i64)> = dict_get(ld, "offsets2")?.extract()?;

            let offsets1_set: HashSet<(i64, i64)> = offsets1.iter().copied().collect();
            let offsets2_set: HashSet<(i64, i64)> = offsets2.iter().copied().collect();
            let mut union: BTreeSet<(i64, i64)> = BTreeSet::new();
            union.extend(offsets1.iter().copied());
            union.extend(offsets2.iter().copied());
            let offsets = union
                .into_iter()
                .map(|(di, dj)| {
                    (
                        di,
                        dj,
                        offsets1_set.contains(&(di, dj)),
                        offsets2_set.contains(&(di, dj)),
                    )
                })
                .collect();

            layer.push(LayerSpec {
                cos_t,
                sin_t,
                reach,
                w_close,
                h0,
                offsets,
            });
        }

        Ok(Spec {
            pattern,
            layers,
            spacing,
            weight,
            pen,
            cross_size,
            cross_aspect,
            jitter,
            seed,
            layer,
        })
    }
}

// --- per-layer caches ---------------------------------------------------
//
// A per-pixel `hash01`/`cell_centre_tone` call recomputes a value that is a
// pure function of a lattice index (line index, wavelength cell, cell
// lattice `(cu, cv)`) shared by every pixel that lands on it — the same
// observation the reference's own story 7 acts on (module docstring), just
// applied over the *whole* image at once (the kernel is not row-banded) and
// entirely as a performance measure: every gather below reads a value
// `build_layer_runtime` already computed by calling the exact same
// functions (`hash01`, `cell_centre_tone`, `c_k`) with the exact same
// integer inputs a direct per-pixel call would use, so it cannot change a
// single bit of output — only how many times the work happens. Measured
// necessary (hatch-kernel.md's shipped note): direct per-pixel hashing
// missed the epic's `crosses`/`lines` budgets by 3x/2x.

/// Bounding `(u_min, u_max, v_min, v_max)` a layer's rotated coordinates
/// take anywhere in the image: `u`/`v` are affine in `(x, y)`, so their
/// extrema over the pixel rectangle occur at one of its four corners.
#[inline]
fn corner_extrema(w: usize, h: usize, cos_t: f32, sin_t: f32) -> (f32, f32, f32, f32) {
    let xs = [0.0f32, (w - 1) as f32, 0.0, (w - 1) as f32];
    let ys = [0.0f32, 0.0, (h - 1) as f32, (h - 1) as f32];
    let mut u_min = f32::INFINITY;
    let mut u_max = f32::NEG_INFINITY;
    let mut v_min = f32::INFINITY;
    let mut v_max = f32::NEG_INFINITY;
    for i in 0..4 {
        let u = xs[i] * cos_t + ys[i] * sin_t;
        let v = -xs[i] * sin_t + ys[i] * cos_t;
        u_min = u_min.min(u);
        u_max = u_max.max(u);
        v_min = v_min.min(v);
        v_max = v_max.max(v);
    }
    (u_min, u_max, v_min, v_max)
}

/// `lines`/`dashes`' wobble hash grid (mirrors `_wobble_grid`), built once
/// over the whole image's `(m, i)` index range rather than per pixel. `m`
/// is the line index (`v_min..v_max` rounded, padded for `dn in -1..=1`);
/// `i` is the wavelength-cell index (`u_min..u_max`, padded `+1` so the
/// same grid gathers both `g0` (`i`) and `g1` (`i + 1`), matching
/// `_wobble_grid`'s own `i_hi = i.max() + 1`).
struct LineWobbleCache {
    m_lo: i64,
    i_lo: i64,
    n_i: i64,
    grid: Vec<f32>,
}

/// `dashes`' per-line phase hash grid (mirrors `_phase_grid`).
struct PhaseCache {
    m_lo: i64,
    grid: Vec<f32>,
}

#[inline]
fn line_m_range(v_min: f32, v_max: f32, spacing_f32: f32) -> (i64, i64) {
    let n0_min = (v_min / spacing_f32).round_ties_even();
    let n0_max = (v_max / spacing_f32).round_ties_even();
    (n0_min as i64 - 2, n0_max as i64 + 2) // -2/+2: dn in -1..=1, plus a rounding margin
}

#[inline]
fn wobble_i_range(u_min: f32, u_max: f32, wavelength: f32) -> (i64, i64) {
    let i_min = (u_min / wavelength).floor();
    let i_max = (u_max / wavelength).floor();
    (i_min as i64 - 1, i_max as i64 + 2) // -1 margin; +2 so `i + 1` (g1) stays in range
}

fn build_wobble_cache(
    spacing_f32: f32,
    k: usize,
    seed: i64,
    u_min: f32,
    u_max: f32,
    v_min: f32,
    v_max: f32,
) -> LineWobbleCache {
    let wavelength = WOBBLE_WAVELENGTH * spacing_f32;
    let (i_lo, i_hi) = wobble_i_range(u_min, u_max, wavelength);
    let (m_lo, m_hi) = line_m_range(v_min, v_max, spacing_f32);
    let n_i = i_hi - i_lo + 1;
    let n_m = m_hi - m_lo + 1;
    let mut grid = vec![0f32; (n_m * n_i) as usize];
    for mi in 0..n_m {
        let m = m_lo + mi;
        for ii in 0..n_i {
            let iv = i_lo + ii;
            let hv = hash01(&[m, iv, k as i64, seed, 4]) as f32;
            grid[(mi * n_i + ii) as usize] = hv;
        }
    }
    LineWobbleCache {
        m_lo,
        i_lo,
        n_i,
        grid,
    }
}

fn build_phase_cache(k: usize, seed: i64, v_min: f32, v_max: f32, spacing_f32: f32) -> PhaseCache {
    let (m_lo, m_hi) = line_m_range(v_min, v_max, spacing_f32);
    let n_m = m_hi - m_lo + 1;
    let mut grid = vec![0f32; n_m as usize];
    for mi in 0..n_m {
        let m = m_lo + mi;
        grid[mi as usize] = hash01(&[m, k as i64, seed]) as f32;
    }
    PhaseCache { m_lo, grid }
}

#[inline]
fn wobble_gather(cache: &LineWobbleCache, m_i: i64, i_i: i64, smooth: f32, disp: f32) -> f32 {
    let idx = ((m_i - cache.m_lo) * cache.n_i + (i_i - cache.i_lo)) as usize;
    let g0 = 2.0f32 * cache.grid[idx] - 1.0f32;
    let g1 = 2.0f32 * cache.grid[idx + 1] - 1.0f32;
    let wv = g0 + (g1 - g0) * smooth;
    disp * wv
}

#[inline]
fn phase_gather(cache: &PhaseCache, m_i: i64) -> f32 {
    cache.grid[(m_i - cache.m_lo) as usize]
}

/// `crosses`' sweep per-cell cache (mirrors `_crosses_ink_sweep`'s own
/// per-layer grid, story 7): `c_n_grid` is `_c_k` at every neighbour cell
/// the whole image's offset sweep can reach; `ju_grid`/`jv_grid` (only
/// built when `jitter > 0`) are that cell's own jitter displacement.
struct CrossesCache {
    cu_lo: i64,
    cv_lo: i64,
    n_v: i64,
    c_n_grid: Vec<f32>,
    ju_grid: Vec<f32>,
    jv_grid: Vec<f32>,
}

#[inline]
fn cell_index_range(min_val: f32, max_val: f32, s: f32, o: f32) -> (i64, i64) {
    let lo = (min_val / s - o).floor() as i64 - 2;
    let hi = (max_val / s - o).ceil() as i64 + 2;
    (lo, hi)
}

#[allow(clippy::too_many_arguments)]
fn build_crosses_cache(
    k: usize,
    spec: &Spec,
    layer: &LayerSpec,
    cos_t: f32,
    sin_t: f32,
    t: &[f32],
    h: usize,
    w: usize,
    u_min: f32,
    u_max: f32,
    v_min: f32,
    v_max: f32,
) -> CrossesCache {
    let s = spec.spacing as f32;
    let o = CELL_OFFSETS[k];

    let (cu_img_lo, cu_img_hi) = cell_index_range(u_min, u_max, s, o.0);
    let (cv_img_lo, cv_img_hi) = cell_index_range(v_min, v_max, s, o.1);

    let di_lo = layer.offsets.iter().map(|&(di, ..)| di).min().unwrap_or(0);
    let di_hi = layer.offsets.iter().map(|&(di, ..)| di).max().unwrap_or(0);
    let dj_lo = layer
        .offsets
        .iter()
        .map(|&(_, dj, ..)| dj)
        .min()
        .unwrap_or(0);
    let dj_hi = layer
        .offsets
        .iter()
        .map(|&(_, dj, ..)| dj)
        .max()
        .unwrap_or(0);

    let cu_lo = cu_img_lo + di_lo;
    let cu_hi = cu_img_hi + di_hi;
    let cv_lo = cv_img_lo + dj_lo;
    let cv_hi = cv_img_hi + dj_hi;
    let n_v = cv_hi - cv_lo + 1;
    let n_u = cu_hi - cu_lo + 1;

    let d_disp = (spec.jitter * spec.spacing / 2.0) as f32;
    let mut c_n_grid = vec![0f32; (n_u * n_v) as usize];
    let mut ju_grid = if spec.jitter > 0.0 {
        vec![0f32; (n_u * n_v) as usize]
    } else {
        Vec::new()
    };
    let mut jv_grid = if spec.jitter > 0.0 {
        vec![0f32; (n_u * n_v) as usize]
    } else {
        Vec::new()
    };

    for ui in 0..n_u {
        let cu_n = cu_lo + ui;
        for vi in 0..n_v {
            let cv_n = cv_lo + vi;
            let idx = (ui * n_v + vi) as usize;
            let u_centre_n = (cu_n as f32 + o.0) * s;
            let v_centre_n = (cv_n as f32 + o.1) * s;
            let t_cell_n = cell_centre_tone(u_centre_n, v_centre_n, cos_t, sin_t, t, h, w);
            let c_n = c_k(t_cell_n, k, spec.layers, spec.weight);
            c_n_grid[idx] = c_n;
            if spec.jitter > 0.0 {
                let disp_n = d_disp * jitter_fade(c_n);
                let h5 = hash01(&[cu_n, cv_n, k as i64, spec.seed, 5]) as f32;
                let h6 = hash01(&[cu_n, cv_n, k as i64, spec.seed, 6]) as f32;
                ju_grid[idx] = disp_n * (2.0f32 * h5 - 1.0f32);
                jv_grid[idx] = disp_n * (2.0f32 * h6 - 1.0f32);
            }
        }
    }

    CrossesCache {
        cu_lo,
        cv_lo,
        n_v,
        c_n_grid,
        ju_grid,
        jv_grid,
    }
}

#[inline]
fn crosses_cache_gather(
    cache: &CrossesCache,
    cu_n: i64,
    cv_n: i64,
    jitter: f64,
) -> (f32, f32, f32) {
    let idx = ((cu_n - cache.cu_lo) * cache.n_v + (cv_n - cache.cv_lo)) as usize;
    let c_n = cache.c_n_grid[idx];
    let (ju_n, jv_n) = if jitter > 0.0 {
        (cache.ju_grid[idx], cache.jv_grid[idx])
    } else {
        (0.0f32, 0.0f32)
    };
    (c_n, ju_n, jv_n)
}

/// One layer's precomputed caches — `None` for whichever this pattern/
/// config doesn't need (e.g. no wobble cache at `jitter == 0`, no crosses
/// cache outside the sweep path).
struct LayerRuntime {
    wobble: Option<LineWobbleCache>,
    phase: Option<PhaseCache>,
    crosses: Option<CrossesCache>,
}

fn build_layer_runtime(spec: &Spec, k: usize, t: &[f32], h: usize, w: usize) -> LayerRuntime {
    let layer = &spec.layer[k];
    let cos_t = layer.cos_t;
    let sin_t = layer.sin_t;
    let (u_min, u_max, v_min, v_max) = corner_extrema(w, h, cos_t, sin_t);
    let spacing_f32 = spec.spacing as f32;

    let mut wobble = None;
    let mut phase = None;
    let mut crosses = None;

    match spec.pattern {
        Pattern::Lines => {
            if spec.jitter > 0.0 {
                wobble = Some(build_wobble_cache(
                    spacing_f32,
                    k,
                    spec.seed,
                    u_min,
                    u_max,
                    v_min,
                    v_max,
                ));
            }
        }
        Pattern::Dashes => {
            if spec.jitter > 0.0 {
                wobble = Some(build_wobble_cache(
                    spacing_f32,
                    k,
                    spec.seed,
                    u_min,
                    u_max,
                    v_min,
                    v_max,
                ));
            }
            phase = Some(build_phase_cache(k, spec.seed, v_min, v_max, spacing_f32));
        }
        Pattern::Crosses => {
            let f1 = spec.cross_size * spec.cross_aspect;
            let f2 = spec.cross_size;
            let sweep = f1.max(f2) > 1.0 || spec.jitter > 0.0;
            if sweep {
                crosses = Some(build_crosses_cache(
                    k, spec, layer, cos_t, sin_t, t, h, w, u_min, u_max, v_min, v_max,
                ));
            }
        }
        Pattern::Stipple => {}
    }

    LayerRuntime {
        wobble,
        phase,
        crosses,
    }
}

fn build_all_layer_runtimes(spec: &Spec, t: &[f32], h: usize, w: usize) -> Vec<LayerRuntime> {
    (0..spec.layers)
        .into_par_iter()
        .map(|k| build_layer_runtime(spec, k, t, h, w))
        .collect()
}

// --- per-pixel dispatch -----------------------------------------------------

fn compute_pixel_f32(
    spec: &Spec,
    runtimes: &[LayerRuntime],
    t: &[f32],
    h: usize,
    w: usize,
    y: usize,
    x: usize,
) -> f32 {
    let xs = x as f32;
    let ys = y as f32;
    let pen_f32 = spec.pen as f32;
    let mut coverage = 0.0f32;

    for k in 0..spec.layers {
        let layer = &spec.layer[k];
        let rt = &runtimes[k];
        let cos_t = layer.cos_t;
        let sin_t = layer.sin_t;
        let u = xs * cos_t + ys * sin_t;
        let v = -xs * sin_t + ys * cos_t;

        let ink_k = match spec.pattern {
            Pattern::Lines => {
                let t_val = t[y * w + x];
                lines_ink(
                    u,
                    v,
                    t_val,
                    k,
                    spec.layers,
                    spec.spacing,
                    spec.weight,
                    pen_f32,
                    spec.jitter,
                    rt.wobble.as_ref(),
                )
            }
            Pattern::Dashes => {
                let t_val = t[y * w + x];
                dashes_ink(
                    u,
                    v,
                    t_val,
                    k,
                    spec.layers,
                    spec.spacing,
                    spec.weight,
                    pen_f32,
                    spec.jitter,
                    rt.wobble.as_ref(),
                    rt.phase
                        .as_ref()
                        .expect("phase cache always built for dashes"),
                )
            }
            Pattern::Stipple => {
                let o = CELL_OFFSETS[k];
                let s = spec.spacing as f32;
                let (du, dv, cu, cv, t_cell) =
                    cell_lattice(u, v, o.0, o.1, s, cos_t, sin_t, t, h, w);
                let c_val = c_k(t_cell, k, spec.layers, spec.weight);
                stipple_ink(du, dv, c_val, cu, cv, k, spec.seed, spec.spacing)
            }
            Pattern::Crosses => crosses_layer_even(
                u,
                v,
                cos_t,
                sin_t,
                k,
                spec,
                layer,
                t,
                h,
                w,
                rt.crosses.as_ref(),
            ),
        };

        coverage = 1.0 - (1.0 - coverage) * (1.0 - ink_k);
    }

    coverage
}

fn compute_pixel_crosses_f64(
    spec: &Spec,
    runtimes: &[LayerRuntime],
    t: &[f32],
    h: usize,
    w: usize,
    y: usize,
    x: usize,
) -> f64 {
    let xs = x as f32;
    let ys = y as f32;
    let mut coverage = 0.0f64;

    for k in 0..spec.layers {
        let layer = &spec.layer[k];
        let rt = &runtimes[k];
        let cos_t = layer.cos_t;
        let sin_t = layer.sin_t;
        let u = xs * cos_t + ys * sin_t;
        let v = -xs * sin_t + ys * cos_t;

        if k % 2 == 0 {
            let ink_k = crosses_layer_even(
                u,
                v,
                cos_t,
                sin_t,
                k,
                spec,
                layer,
                t,
                h,
                w,
                rt.crosses.as_ref(),
            );
            coverage = 1.0 - (1.0 - coverage) * (1.0 - (ink_k as f64));
        } else {
            let ink_k = crosses_layer_odd(
                u,
                v,
                cos_t,
                sin_t,
                k,
                spec,
                layer,
                t,
                h,
                w,
                rt.crosses.as_ref(),
            );
            coverage = 1.0 - (1.0 - coverage) * (1.0 - ink_k);
        }
    }

    coverage
}

// --- entry point --------------------------------------------------------

/// `hatch_coverage(t, spec) -> np.ndarray[(h, w)]`, `float32` or `float64`
/// depending on config (see module docs). `spec` is the dict `_build_spec`
/// assembles in `ops/hatch.py`. Rayon over rows, GIL released.
#[pyfunction]
fn hatch_coverage<'py>(
    py: Python<'py>,
    t: PyReadonlyArray2<'py, f32>,
    spec: &Bound<'py, PyDict>,
) -> PyResult<Py<PyAny>> {
    let spec = Spec::parse(spec)?;
    let t_view = t.as_array();
    let h = t_view.shape()[0];
    let w = t_view.shape()[1];
    // A contiguous `&[f32]` (row-major `t[y*w+x]`) indexes far faster than
    // `ArrayView2`'s generic `Ix2` machinery in the per-pixel hot loop.
    // `_tone` always hands back a C-contiguous array (`.as_slice()` then
    // succeeds without copying); the `to_owned` fallback only pays for a
    // copy in the case that never happens in practice, never for values.
    let t_owned;
    let t_slice: &[f32] = match t_view.as_slice() {
        Some(s) => s,
        None => {
            t_owned = t_view.to_owned();
            t_owned.as_slice().expect("to_owned() is always contiguous")
        }
    };

    let crosses_f64 = matches!(spec.pattern, Pattern::Crosses) && spec.layers >= 2;

    if crosses_f64 {
        let mut out = vec![0f64; h * w];
        py.detach(|| {
            let runtimes = build_all_layer_runtimes(&spec, t_slice, h, w);
            out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
                for (x, cell) in row.iter_mut().enumerate() {
                    *cell = compute_pixel_crosses_f64(&spec, &runtimes, t_slice, h, w, y, x);
                }
            });
        });
        let arr = Array2::from_shape_vec((h, w), out).expect("row-major shape matches out.len()");
        Ok(arr.into_pyarray(py).into_any().unbind())
    } else {
        let mut out = vec![0f32; h * w];
        py.detach(|| {
            let runtimes = build_all_layer_runtimes(&spec, t_slice, h, w);
            out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
                for (x, cell) in row.iter_mut().enumerate() {
                    *cell = compute_pixel_f32(&spec, &runtimes, t_slice, h, w, y, x);
                }
            });
        });
        let arr = Array2::from_shape_vec((h, w), out).expect("row-major shape matches out.len()");
        Ok(arr.into_pyarray(py).into_any().unbind())
    }
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(hatch_coverage, m)?)
}
