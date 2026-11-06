//! Depth-aware blur whose radius follows a driver plane (Epic 27 story 1).
//!
//! Reference and statement of the maths: `sidecar/ops/_driven_blur.py`
//! (module docstring and `driven_blur_reference`). This file replicates it
//! expression by expression in plain IEEE `f32` (no FMA, no fast-math), so
//! the bytes match the reference (architecture decision 11a).
//!
//! **Method, briefly.** Scatter-as-gather with the min-CoC depth test:
//! `w(p, q) = G_{min(sigma_p, sigma_q)}(p - q)`. A nearer sample scatters with
//! its own Gaussian; a farther one is occluded and reaches `p` only as far as
//! `p`'s own Gaussian. So a uniform region gets exactly its Gaussian, a sharp
//! pixel gets nothing but itself (no halo of background over a sharp near
//! edge), a sharp near pixel gives nothing to the background beside it (the
//! edge stays crisp), and a blurred near object spreads over what's behind
//! it. A plain gather leaks foreground into background; a plain scatter
//! haloes background over foreground; the min rule does neither.
//!
//! **Speed.** Each pixel is computed at the pyramid level where its sigma is
//! 2 to 4 level pixels, with the pyramid's own variance (prefilter and cubic
//! B-spline upsample) subtracted from the gather, so every level computes the
//! same sigma and only the sampling changes. Pixels near a level boundary are
//! computed at both levels and crossfaded. Nearer classes are kept out of a
//! level's image and come in as their own scatter (`S_j`) from their own
//! level, so a sharp foreground never gets averaged into a coarse level.
//!
//! Python (`build_spec`) hands in every non-per-pixel number: each plane
//! value's class, the crossfade weights, per-level Gaussian tables and radii,
//! and the B-spline phase weights. Rayon splits rows; each output value is
//! summed in one fixed order, so the result is deterministic.

use numpy::ndarray::{Array3, ArrayView2, ArrayView3};
use numpy::{IntoPyArray, PyArray3, PyReadonlyArray1, PyReadonlyArray2, PyReadonlyArray3};
use pyo3::exceptions::{PyKeyError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use rayon::prelude::*;

type Px = [f32; 5]; // premultiplied r, g, b, coverage, v * coverage
type Px4 = [f32; 4]; // premultiplied r, g, b, coverage (or weight)

const ZERO: Px = [0.0; 5];
const THREE: f32 = 3.0;
const EIGHTH: f32 = 0.125;
/// Skip-mask tile size, in cells of the level it describes.
const TILE: usize = 16;

struct Grid {
    w: usize,
    h: usize,
    data: Vec<Px>,
    /// Rows holding any non-zero coverage.
    live: Vec<bool>,
}

struct Level {
    table: Vec<f32>, // 256 x width
    width: usize,
    radii: [i32; 256],
}

struct Spec {
    levels: usize,
    klass: [u8; 256],
    fade: [f32; 256],
    unfade: [f32; 256],
    tab: Vec<Level>,
    bspline: Vec<Vec<[f32; 4]>>,
}

#[inline]
fn down4(a: &Px, b: &Px, c: &Px, d: &Px) -> Px {
    let mut o = [0.0f32; 5];
    for i in 0..5 {
        o[i] = ((a[i] + b[i] * THREE) + c[i] * THREE + d[i]) * EIGHTH;
    }
    o
}

/// 2x downsample (x then y), `[1,3,3,1]/8`, zero past the edges, as the
/// reference's `_down`. `get(y, x)` reads the source; `live[y]` says whether
/// source row y may be non-zero (a dead row reads as zeros, which is what it
/// holds, so skipping it changes no bit).
fn down<F>(sw: usize, sh: usize, live: &[bool], get: F) -> Grid
where
    F: Fn(usize, usize) -> Px + Sync,
{
    let w = sw.div_ceil(2);
    let h = sh.div_ceil(2);
    let is_live = |y: isize| y >= 0 && (y as usize) < sh && live[y as usize];
    let hrow = |y: isize, buf: &mut Vec<Px>| {
        buf.clear();
        if !is_live(y) {
            buf.resize(w, ZERO);
            return;
        }
        let y = y as usize;
        let at = |x: isize| -> Px {
            if x < 0 || x as usize >= sw {
                ZERO
            } else {
                get(y, x as usize)
            }
        };
        buf.extend((0..w).map(|i| {
            let x = 2 * i as isize;
            down4(&at(x - 1), &at(x), &at(x + 1), &at(x + 2))
        }));
    };
    let mut data = vec![ZERO; w * h];
    let mut out_live = vec![false; h];
    data.par_chunks_mut(w)
        .zip(out_live.par_iter_mut())
        .enumerate()
        .for_each(|(i, (row, lv))| {
            let y = 2 * i as isize;
            if !(is_live(y - 1) || is_live(y) || is_live(y + 1) || is_live(y + 2)) {
                return;
            }
            let mut r = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
            for (o, buf) in r.iter_mut().enumerate() {
                hrow(y - 1 + o as isize, buf);
            }
            for x in 0..w {
                row[x] = down4(&r[0][x], &r[1][x], &r[2][x], &r[3][x]);
            }
            *lv = row.iter().any(|p| p[3] > 0.0);
        });
    Grid {
        w,
        h,
        data,
        live: out_live,
    }
}

fn down_grid(g: &Grid) -> Grid {
    down(g.w, g.h, &g.live, |y, x| g.data[y * g.w + x])
}

/// `rint(v*cov / cov)` where cov > 0, else 0 (the reference's `_vbar`).
fn vbar(g: &Grid) -> Vec<u8> {
    g.data
        .par_iter()
        .map(|p| {
            if p[3] > 0.0 {
                (p[4] / p[3]).round_ties_even() as u8
            } else {
                0
            }
        })
        .collect()
}

/// Jacobi fill of empty cells from their filled 8-neighbours, 3 passes;
/// still-empty cells get 255 (the reference's `_fill_v`).
fn fill_v(v: &[u8], valid0: &[bool], w: usize, h: usize) -> Vec<u8> {
    let mut v = v.to_vec();
    let mut valid = valid0.to_vec();
    for _ in 0..3 {
        let mut nv = v.clone();
        let mut nvalid = valid.clone();
        nv.par_chunks_mut(w)
            .zip(nvalid.par_chunks_mut(w))
            .enumerate()
            .for_each(|(y, (vrow, okrow))| {
                for x in 0..w {
                    if valid[y * w + x] {
                        continue;
                    }
                    let mut total = 0.0f32;
                    let mut count = 0.0f32;
                    for dy in -1isize..=1 {
                        for dx in -1isize..=1 {
                            if dy == 0 && dx == 0 {
                                continue;
                            }
                            let yy = y as isize + dy;
                            let xx = x as isize + dx;
                            let inside = yy >= 0 && xx >= 0 && yy < h as isize && xx < w as isize;
                            let (sv, sc) = if inside {
                                let j = yy as usize * w + xx as usize;
                                if valid[j] {
                                    (v[j] as f32, 1.0)
                                } else {
                                    (0.0, 0.0)
                                }
                            } else {
                                (0.0, 0.0)
                            };
                            total += sv;
                            count += sc;
                        }
                    }
                    if count > 0.0 {
                        vrow[x] = (total / count).round_ties_even() as u8;
                        okrow[x] = true;
                    }
                }
            });
        v = nv;
        valid = nvalid;
    }
    v.iter()
        .zip(&valid)
        .map(|(&x, &ok)| if ok { x } else { 255 })
        .collect()
}

/// Chebyshev dilation by `r` cells.
fn dilate(mask: &[bool], w: usize, h: usize, r: usize) -> Vec<bool> {
    if r == 0 {
        return mask.to_vec();
    }
    let mut tmp = vec![false; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, out)| {
        let row = &mask[y * w..(y + 1) * w];
        let mut last: isize = -(r as isize) - 1; // last set index seen
        let mut next = vec![isize::MAX; w]; // next set index at or after x
        let mut n = isize::MAX;
        for x in (0..w).rev() {
            if row[x] {
                n = x as isize;
            }
            next[x] = n;
        }
        for x in 0..w {
            if row[x] {
                last = x as isize;
            }
            out[x] = x as isize - last <= r as isize || next[x] - (x as isize) <= r as isize;
        }
    });
    let mut out = vec![false; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, o)| {
        let lo = y.saturating_sub(r);
        let hi = (y + r + 1).min(h);
        for yy in lo..hi {
            for (dst, &src) in o.iter_mut().zip(&tmp[yy * w..(yy + 1) * w]) {
                *dst |= src;
            }
        }
    });
    out
}

/// Cells of level `k` (dims `lw` x `lh`) holding a fine pixel for which
/// `pred(i)` holds.
fn cell_mask<P>(k: usize, w: usize, h: usize, lw: usize, pred: P) -> Vec<bool>
where
    P: Fn(usize) -> bool + Sync,
{
    let lh = h.div_ceil(1 << k);
    let mut m = vec![false; lw * lh];
    m.par_chunks_mut(lw).enumerate().for_each(|(cy, row)| {
        let y0 = cy << k;
        let y1 = ((cy + 1) << k).min(h);
        for y in y0..y1 {
            for x in 0..w {
                if pred(y * w + x) {
                    row[x >> k] = true;
                }
            }
        }
    });
    m
}

/// A tile mask: tile (ty, tx) of `TILE` cells is true when any cell in it is.
fn tiles_of(mask: &[bool], w: usize, h: usize) -> (Vec<bool>, usize, usize) {
    let tw = w.div_ceil(TILE);
    let th = h.div_ceil(TILE);
    let mut t = vec![false; tw * th];
    t.par_chunks_mut(tw).enumerate().for_each(|(ty, row)| {
        for y in ty * TILE..((ty + 1) * TILE).min(h) {
            for x in 0..w {
                if mask[y * w + x] {
                    row[x / TILE] = true;
                }
            }
        }
    });
    (t, tw, th)
}

#[inline]
fn isqrt(n: i32) -> i32 {
    if n < 0 {
        return -1;
    }
    let mut r = (n as f64).sqrt() as i32;
    while r * r > n {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    r
}

/// One gather point: the sum over offsets in raster order (dy, then dx) of
/// `w * src`, where `w` is the level's table at `m = min(pv, v_q)`
/// (`MIN_RULE`) or `v_q` (scatter of one class), zero outside the circle of
/// radius `radii[m]`. `rwin` bounds the window as a circle; every tap outside
/// it has zero weight. `ok(i)` rejects source cells known to be empty (their
/// contribution is +0, so skipping them changes no bit).
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn gather<const MIN_RULE: bool, OK: Fn(usize) -> bool, C: Fn(usize) -> Px4>(
    y: usize,
    x: usize,
    w: usize,
    h: usize,
    pv: u8,
    rwin: i32,
    lv: &Level,
    col: C,
    vv: &[u8],
    ok: OK,
) -> Px4 {
    let mut acc = [0.0f32; 4];
    let tw = lv.width;
    let tab = &lv.table[..];
    let r2win = rwin * rwin;
    for dy in -rwin..=rwin {
        let yy = y as isize + dy as isize;
        if yy < 0 || yy >= h as isize {
            continue;
        }
        let rx = isqrt(r2win - dy * dy) as isize;
        let xlo = (x as isize - rx).max(0) as usize;
        let xhi = (x as isize + rx).min(w as isize - 1);
        if xhi < xlo as isize {
            continue;
        }
        let xhi = xhi as usize;
        let ady = dy.unsigned_abs() as usize;
        let row = yy as usize * w;
        let vs = &vv[row + xlo..=row + xhi];
        for (o, &sv) in vs.iter().enumerate() {
            let xx = xlo + o;
            if !ok(row + xx) {
                continue;
            }
            let m = if MIN_RULE { pv.min(sv) } else { sv } as usize;
            let dx = xx as i32 - x as i32;
            let r = lv.radii[m];
            if dx * dx + dy * dy > r * r {
                continue;
            }
            let adx = dx.unsigned_abs() as usize;
            let wgt = tab[m * tw + adx] * tab[m * tw + ady];
            let s = col(row + xx);
            for c in 0..4 {
                acc[c] += wgt * s[c];
            }
        }
    }
    acc
}

/// Cubic B-spline value of a level-`k` grid at fine pixel (y, x), taps
/// clamped to the grid (the reference's `_upsample`, one pixel at a time).
#[inline]
fn up_at(g: &[Px4], gw: usize, gh: usize, k: usize, bs: &[[f32; 4]], y: usize, x: usize) -> Px4 {
    if k == 0 {
        return g[y * gw + x];
    }
    let s = 1i64 << k;
    let by = (2 * y as i64 + 1 - s).div_euclid(2 * s) - 1;
    let bx = (2 * x as i64 + 1 - s).div_euclid(2 * s) - 1;
    let wy = bs[(y as i64 % s) as usize];
    let wx = bs[(x as i64 % s) as usize];
    let mut xi = [0usize; 4];
    for (ix, slot) in xi.iter_mut().enumerate() {
        *slot = (bx + ix as i64).clamp(0, gw as i64 - 1) as usize;
    }
    let mut out = [0.0f32; 4];
    for (iy, &wyi) in wy.iter().enumerate() {
        let yi = (by + iy as i64).clamp(0, gh as i64 - 1) as usize;
        let base = yi * gw;
        let mut row = [0.0f32; 4];
        for (ix, &wxi) in wx.iter().enumerate() {
            let v = g[base + xi[ix]];
            for c in 0..4 {
                row[c] += wxi * v[c];
            }
        }
        for c in 0..4 {
            out[c] += wyi * row[c];
        }
    }
    out
}

struct Computed {
    w: usize,
    h: usize,
    vals: Vec<Px4>,
    /// S levels only: per tile of the level, whether a fine pixel's footprint
    /// there may read a non-zero value. Outside it every read is +0.
    may: Vec<bool>,
    tw: usize,
}

/// Fill `vals` at the cells where `want(i)` holds, rows in parallel.
fn compute_cells<W, G>(lw: usize, lh: usize, want: W, at: G) -> Vec<Px4>
where
    W: Fn(usize) -> bool + Sync,
    G: Fn(usize, usize) -> Px4 + Sync,
{
    let mut vals = vec![[0.0f32; 4]; lw * lh];
    vals.par_chunks_mut(lw).enumerate().for_each(|(y, row)| {
        for (x, slot) in row.iter_mut().enumerate() {
            if want(y * lw + x) {
                *slot = at(y, x);
            }
        }
    });
    vals
}

fn run(rgb: ArrayView3<u8>, v: ArrayView2<u8>, spec: &Spec) -> Array3<u8> {
    let (h, w) = (v.shape()[0], v.shape()[1]);
    let levels = spec.levels;
    let trace = std::env::var_os("OBLIQUE_TRACE").is_some();
    let t0 = std::time::Instant::now();
    let lap = |what: &str| {
        if trace {
            eprintln!("{what}: {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0)
        }
    };

    let rgb = rgb.as_standard_layout();
    let rgb = rgb.as_slice().expect("contiguous");
    let v = v.as_standard_layout();
    let vs: &[u8] = v.as_slice().expect("contiguous");
    let kl_owned: Vec<u8> = vs.par_iter().map(|&x| spec.klass[x as usize]).collect();
    let kl: &[u8] = &kl_owned;
    let col0 = |i: usize| -> Px4 {
        [
            rgb[3 * i] as f32,
            rgb[3 * i + 1] as f32,
            rgb[3 * i + 2] as f32,
            1.0,
        ]
    };
    let fading = |vv: u8| spec.fade[vv as usize] < 1.0;
    // Bit j set: fine row holds a class-j pixel.
    let row_classes: Vec<u32> = kl
        .par_chunks(w)
        .map(|r| r.iter().fold(0u32, |a, &k| a | (1 << k)))
        .collect();
    let mut class_present = vec![false; levels];
    let all = row_classes.iter().fold(0u32, |a, &b| a | b);
    for (k, slot) in class_present.iter_mut().enumerate() {
        *slot = all & (1 << k) != 0;
    }
    let mut dims = vec![(w, h)];
    for k in 1..levels {
        let (pw, ph) = dims[k - 1];
        dims.push((pw.div_ceil(2), ph.div_ceil(2)));
    }
    lap("prep");

    // Per-class chains in ascending class order; A_k = sum_{j>=k} E_j^(k),
    // accumulated in that order (the reference's sum, bit for bit).
    let mut big_a: Vec<Option<Grid>> = (0..levels).map(|_| None).collect();
    let mut e_own: Vec<Option<Grid>> = (0..levels).map(|_| None).collect();
    for j in 1..levels {
        if !class_present[j] {
            continue;
        }
        let jj = j as u8;
        let live: Vec<bool> = row_classes.iter().map(|&b| b & (1 << j) != 0).collect();
        let mut g = down(w, h, &live, |y, x| {
            let i = y * w + x;
            if kl[i] == jj {
                let c = col0(i);
                [c[0], c[1], c[2], c[3], vs[i] as f32]
            } else {
                ZERO
            }
        });
        for k in 1..=j {
            if k > 1 {
                g = down_grid(&g);
            }
            match &mut big_a[k] {
                None => {
                    big_a[k] = Some(Grid {
                        w: g.w,
                        h: g.h,
                        data: g.data.clone(),
                        live: g.live.clone(),
                    });
                }
                Some(a) => {
                    a.data
                        .par_iter_mut()
                        .zip(g.data.par_iter())
                        .for_each(|(dst, src)| {
                            for c in 0..5 {
                                dst[c] += src[c];
                            }
                        });
                    for (l, &s) in a.live.iter_mut().zip(&g.live) {
                        *l |= s;
                    }
                }
            }
        }
        e_own[j] = Some(g);
    }
    lap("chains");

    // F_k: own level and farther, min rule.
    let mut f_levels: Vec<Option<Computed>> = (0..levels).map(|_| None).collect();
    for k in 0..levels {
        let kk = k as u8;
        let reads = |i: usize| kl[i] == kk || (kl[i] == kk + 1 && fading(vs[i]));
        let (lw, lh) = dims[k];
        let lv = &spec.tab[k];
        let vals = if k == 0 {
            if !(class_present[0] || (levels > 1 && class_present[1])) {
                continue;
            }
            compute_cells(lw, lh, reads, |y, x| {
                let pv = vs[y * lw + x];
                gather::<true, _, _>(
                    y,
                    x,
                    lw,
                    lh,
                    pv,
                    lv.radii[pv as usize],
                    lv,
                    col0,
                    vs,
                    |_| true,
                )
            })
        } else {
            if !(class_present[k] || (k + 1 < levels && class_present[k + 1])) {
                continue;
            }
            let readers = cell_mask(k, w, h, lw, reads);
            if !readers.iter().any(|&b| b) {
                continue;
            }
            let need = dilate(&readers, lw, lh, 2);
            let a = big_a[k].as_ref().expect("A_k built for a needed level");
            let sv = vbar(a);
            let valid: Vec<bool> = a.data.par_iter().map(|p| p[3] > 0.0).collect();
            let pvs = fill_v(&sv, &valid, lw, lh);
            let col: Vec<Px4> = a
                .data
                .par_iter()
                .map(|p| [p[0], p[1], p[2], p[3]])
                .collect();
            compute_cells(
                lw,
                lh,
                |i| need[i],
                |y, x| {
                    let pv = pvs[y * lw + x];
                    gather::<true, _, _>(
                        y,
                        x,
                        lw,
                        lh,
                        pv,
                        lv.radii[pv as usize],
                        lv,
                        |i| col[i],
                        &sv,
                        |i| valid[i],
                    )
                },
            )
        };
        f_levels[k] = Some(Computed {
            w: lw,
            h: lh,
            vals,
            may: Vec::new(),
            tw: 0,
        });
        lap(&format!("  F{k}"));
    }

    // S_j: scatter of class j, read by pixels of class > j.
    let mut s_levels: Vec<Option<Computed>> = (0..levels).map(|_| None).collect();
    for j in 0..levels.saturating_sub(1) {
        if !class_present[j] || !class_present[j + 1..].iter().any(|&b| b) {
            continue;
        }
        let jj = j as u8;
        let (lw, lh) = dims[j];
        let lv = &spec.tab[j];
        let mut rmax = 0i32;
        for (vv, &k) in spec.klass.iter().enumerate() {
            if k == jj {
                rmax = rmax.max(lv.radii[vv]);
            }
        }
        let pad = if j == 0 { 0 } else { 2 };
        let (vals, may, tw) = if j == 0 {
            let is_src: Vec<bool> = kl.par_iter().map(|&k| k == 0).collect();
            let (st, tw, th) = tiles_of(&is_src, w, h);
            let reach = dilate(&st, tw, th, (rmax as usize).div_ceil(TILE));
            let vals = compute_cells(
                w,
                h,
                |i| kl[i] > 0 && reach[((i / w) / TILE) * tw + (i % w) / TILE],
                |y, x| gather::<false, _, _>(y, x, w, h, 0, rmax, lv, col0, vs, |i| kl[i] == 0),
            );
            (vals, reach, tw)
        } else {
            let e = e_own[j].as_ref().expect("class chain built");
            let readers = cell_mask(j, w, h, lw, |i| kl[i] > jj);
            let band = dilate(&readers, lw, lh, pad);
            let sv = vbar(e);
            let is_src: Vec<bool> = e.data.par_iter().map(|p| p[3] > 0.0).collect();
            let (st, tw, th) = tiles_of(&is_src, lw, lh);
            let reach = dilate(&st, tw, th, (rmax as usize).div_ceil(TILE));
            let may = dilate(&st, tw, th, (rmax as usize + pad).div_ceil(TILE));
            let col: Vec<Px4> = e
                .data
                .par_iter()
                .map(|p| [p[0], p[1], p[2], p[3]])
                .collect();
            let vals = compute_cells(
                lw,
                lh,
                |i| band[i] && reach[((i / lw) / TILE) * tw + (i % lw) / TILE],
                |y, x| {
                    gather::<false, _, _>(y, x, lw, lh, 0, rmax, lv, |i| col[i], &sv, |i| is_src[i])
                },
            );
            (vals, may, tw)
        };
        s_levels[j] = Some(Computed {
            w: lw,
            h: lh,
            vals,
            may,
            tw,
        });
        lap(&format!("  S{j}"));
    }

    // Compose: numerator and denominator from S_0..S_{k-1} then F_k, divided.
    let colour_at = |k: usize, y: usize, x: usize| -> [f32; 3] {
        let mut acc = [0.0f32; 4];
        for (j, s) in s_levels.iter().enumerate().take(k) {
            let Some(s) = s else { continue };
            let (cy, cx) = (y >> j, x >> j);
            if !s.may[(cy / TILE) * s.tw + cx / TILE] {
                continue;
            }
            let u = up_at(&s.vals, s.w, s.h, j, &spec.bspline[j], y, x);
            for c in 0..4 {
                acc[c] += u[c];
            }
        }
        let f = f_levels[k].as_ref().expect("F_k computed for its readers");
        let u = up_at(&f.vals, f.w, f.h, k, &spec.bspline[k], y, x);
        for c in 0..4 {
            acc[c] += u[c];
        }
        let den = if acc[3] > 0.0 { acc[3] } else { 1.0 };
        [acc[0] / den, acc[1] / den, acc[2] / den]
    };

    let mut out = vec![0u8; w * h * 3];
    out.par_chunks_mut(w * 3).enumerate().for_each(|(y, orow)| {
        for x in 0..w {
            let i = y * w + x;
            let k = kl[i] as usize;
            let vv = vs[i] as usize;
            let mut c = colour_at(k, y, x);
            if k >= 1 && spec.fade[vv] < 1.0 {
                let cf = colour_at(k - 1, y, x);
                for ch in 0..3 {
                    c[ch] = cf[ch] * spec.unfade[vv] + c[ch] * spec.fade[vv];
                }
            }
            for ch in 0..3 {
                orow[3 * x + ch] = c[ch].round_ties_even().clamp(0.0, 255.0) as u8;
            }
        }
    });
    lap("compose");
    Array3::from_shape_vec((h, w, 3), out).expect("shape")
}

// --- Python boundary ---------------------------------------------------------

fn get<'py>(d: &Bound<'py, PyDict>, key: &str) -> PyResult<Bound<'py, PyAny>> {
    d.get_item(key)?
        .ok_or_else(|| PyKeyError::new_err(key.to_string()))
}

fn arr256<T: Copy + numpy::Element>(a: PyReadonlyArray1<T>, name: &str) -> PyResult<[T; 256]> {
    let s = a.as_slice()?;
    s.try_into()
        .map_err(|_| PyValueError::new_err(format!("{name} must have 256 entries")))
}

fn parse_spec(d: &Bound<'_, PyDict>) -> PyResult<Spec> {
    let levels: usize = get(d, "levels")?.extract()?;
    let klass = arr256(get(d, "klass")?.extract::<PyReadonlyArray1<u8>>()?, "klass")?;
    let fade = arr256(get(d, "fade")?.extract::<PyReadonlyArray1<f32>>()?, "fade")?;
    let unfade = arr256(
        get(d, "unfade")?.extract::<PyReadonlyArray1<f32>>()?,
        "unfade",
    )?;
    let tables = get(d, "tables")?.cast_into::<PyList>()?;
    let radii = get(d, "radii")?.cast_into::<PyList>()?;
    let bsp = get(d, "bspline")?.cast_into::<PyList>()?;
    if tables.len() != levels || radii.len() != levels || bsp.len() != levels {
        return Err(PyValueError::new_err(
            "tables, radii and bspline need one entry per level",
        ));
    }
    if klass.iter().any(|&k| k as usize >= levels) {
        return Err(PyValueError::new_err("klass names a level past `levels`"));
    }
    let mut tab = Vec::with_capacity(levels);
    let mut bspline = Vec::with_capacity(levels);
    for k in 0..levels {
        let t: PyReadonlyArray2<f32> = tables.get_item(k)?.extract()?;
        let r = arr256(
            radii.get_item(k)?.extract::<PyReadonlyArray1<i32>>()?,
            "radii",
        )?;
        let tv = t.as_array();
        if tv.shape()[0] != 256 {
            return Err(PyValueError::new_err("each table needs 256 rows"));
        }
        let width = tv.shape()[1];
        if r.iter().any(|&x| x < 0 || x as usize >= width) {
            return Err(PyValueError::new_err("a radius runs past its table"));
        }
        tab.push(Level {
            table: tv.iter().copied().collect(),
            width,
            radii: r,
        });
        let b: PyReadonlyArray2<f32> = bsp.get_item(k)?.extract()?;
        let bv = b.as_array();
        if bv.shape() != [1usize << k, 4] {
            return Err(PyValueError::new_err("bspline[k] must be (2^k, 4)"));
        }
        bspline.push(
            bv.outer_iter()
                .map(|row| [row[0], row[1], row[2], row[3]])
                .collect(),
        );
    }
    Ok(Spec {
        levels,
        klass,
        fade,
        unfade,
        tab,
        bspline,
    })
}

/// `driven_blur(rgb, v, spec) -> rgb`: `rgb` (h, w, 3) uint8, `v` (h, w)
/// uint8 plane values, `spec` from `ops/_driven_blur.py::build_spec`.
#[pyfunction]
fn driven_blur<'py>(
    py: Python<'py>,
    rgb: PyReadonlyArray3<'py, u8>,
    v: PyReadonlyArray2<'py, u8>,
    spec: &Bound<'py, PyDict>,
) -> PyResult<Bound<'py, PyArray3<u8>>> {
    let spec = parse_spec(spec)?;
    let rgb_v = rgb.as_array();
    let v_v = v.as_array();
    if rgb_v.shape()[2] != 3 || rgb_v.shape()[..2] != *v_v.shape() {
        return Err(PyValueError::new_err("rgb must be (h, w, 3) and v (h, w)"));
    }
    let out = py.detach(|| run(rgb_v, v_v, &spec));
    Ok(out.into_pyarray(py))
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(driven_blur, m)?)?;
    Ok(())
}
