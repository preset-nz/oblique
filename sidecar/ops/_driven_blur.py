"""Depth-aware blur whose radius follows a driver plane (Epic 27 story 1).

Private module: `gaussian_blur` calls `driven_blur` when a radius driver is
attached. This file is the statement of the maths and its NumPy reference;
the shipping path is the Rust kernel `oblique_kernels.driven_blur`
(`sidecar/kernels/src/driven_blur.rs`). The reference is the reference for the
look. The kernel matches it byte for byte today and the tests hold it to that,
but that is a convenience, not a requirement (Georg, 2026-11-07: "if it looks
right it is right"): a kernel change that keeps the look may relax it to a
tolerance against this file and against the exact weighting. The reference is
a direct, slow implementation: use it on small images only (tests run it at
64x48).

## The look it has to give

Each pixel `p` has its own Gaussian standard deviation
`sigma_p = plane_p * radius` (radius is `ImageFilter.GaussianBlur`'s, which is
the standard deviation; driver white means the full radius, black means
sharp). A larger sigma counts as farther away.

## The weight: scatter-as-gather with a depth test

`out(p) = sum_q w(p,q) c_q / sum_q w(p,q)` with

    w(p, q) = G_{min(sigma_p, sigma_q)}(p - q)

where `G_s` is a Gaussian of standard deviation `s`, normalised to unit sum.
Read as a scatter: every pixel spreads its colour with its own Gaussian, as
a lens spreads a point into a disc. A nearer pixel (`sigma_q < sigma_p`)
reaches `p` with its own, narrower spread. A farther pixel is occluded by
`p` and only reaches it as far as `p`'s own spread. So:

- in a region of one sigma the result is exactly the Gaussian blur of that
  sigma;
- a sharp pixel (`sigma = 0`) receives nothing but itself: no halo of
  blurred background over a sharp near edge;
- a sharp near pixel gives nothing to the blurred background beside it, so
  the background is averaged from background only and the edge stays crisp;
- a blurred near object spreads over what's behind it by its own sigma.

This is the min-CoC rule of scatter-as-gather depth of field (the "near
samples scatter with their own circle, far samples are clamped to the
centre's circle" test used in Jimenez 2014 and in single-pass bokeh
filters). A plain gather (`G_{sigma_p}` for every `q`) leaks a sharp
foreground into the blurred background; a plain scatter (`G_{sigma_q}`)
haloes the background over a sharp foreground.

## A speckled plane is filtered first

Per-pixel noise in the plane would put every pixel at a different pyramid
level, and every level would then compute everything (seconds at 4096 px).
So a plane that is speckled rather than a map, by `NOISE_STEP` and
`NOISE_SHARE` below, gets a 3x3 median, up to `DENOISE_PASSES` times
(`denoise_plane`). A median keeps a step edge where it is, so a near object
stays crisp, and it drops speckle. A map is not touched.

## Doing it fast: a pyramid that changes resolution, not sigma

At radius 50 a full-resolution gather is ~70 000 taps per pixel. Instead
each pixel is computed at the pyramid level where its sigma is 2 to 4 level
pixels, which is ~50 to 450 taps. Every level computes the *same* sigma (the
level's prefilter and the cubic B-spline upsampling are Gaussian-like and
their variance is subtracted from the gather's), so levels differ only in
sampling, not in blur. Near a level boundary a pixel is computed at both
levels and crossfaded, so there is no seam. This is not a stack of fixed
blurs: no pixel blends two different sigmas.

Pixels are partitioned into classes by level (`klass`). Level `k` holds two
premultiplied images built by repeated 2x downsampling (`[1,3,3,1]/8`):

- `A_k`: every pixel of class `>= k` (the pixel's own level and farther);
- `E_k`: the pixels of class exactly `k`.

For a pixel of class `k`, its numerator and denominator are

    F_k(p)       gather over A_k with the min rule (own level and farther)
  + sum_{j<k} S_j(p)  scatter of each nearer class j, computed at level j

each upsampled from its level with a cubic B-spline (level 0 needs none).
The nearer classes are kept out of `A_k`, so a sharp foreground can't be
averaged into a coarse level and leak into the background.

Everything numeric that is not per-pixel arithmetic (the class of each
plane value, the crossfade weights, the per-level Gaussian tables, the
B-spline phase weights) is computed here in Python and handed to the
kernel, so neither side derives weights. Sums run in one fixed order per
pixel; the kernel replicates that order with plain IEEE float32 (no FMA).
"""

from __future__ import annotations

import functools
import math
from typing import Any

import numpy as np

# A pixel is computed at level k >= 1 when its sigma, in level-k pixels, is
# in [LEVEL_LOW, 2 * LEVEL_LOW); level 0 takes sigma < 2 * LEVEL_LOW. 2 level
# pixels is where the pyramid's sampling error is under one 8-bit step.
LEVEL_LOW = 2.0
# Pixels whose sigma is within this factor above their level's floor are
# also computed one level finer and crossfaded across the band.
FADE_BAND = 1.25
# A plane that is speckled rather than a map is median-filtered first (see
# `denoise_plane`). A pixel is speckle when it differs by more than NOISE_STEP
# from its right and its lower neighbour at once (an edge steps along one axis
# only); the plane is speckled when more than NOISE_SHARE of the pixels on
# every 5th row are. Real depth maps measure under 0.01 % here, Gaussian noise
# of sd 6 about 4 %. At most DENOISE_PASSES passes.
NOISE_STEP = 12
NOISE_SHARE = 0.005
DENOISE_PASSES = 4
# Gaussian tables are cut at 3 sigma, as a circle.
SUPPORT = 3.0
# Variance (in a level's own pixels) the pyramid adds on its own: the
# cascaded [1,3,3,1]/8 prefilter, 0.75 finer-level px^2 per stage, and the
# cubic B-spline upsample, 1/3 level px^2.
_PREFILTER_VAR = 0.75
_BSPLINE_VAR = 1.0 / 3.0


def _sigma_of(v: int, radius: float) -> float:
    return v / 255.0 * radius


def _klass_of(sigma: float) -> int:
    k = 0
    floor = 2.0 * LEVEL_LOW
    while sigma >= floor:
        k += 1
        floor *= 2.0
    return k


def _level_extra_var(k: int) -> float:
    """Variance the pyramid itself adds at level k, in level-k px^2."""
    if k == 0:
        return 0.0
    s2 = float(4**k)
    prefilter = _PREFILTER_VAR * (s2 - 1.0) / 3.0  # sum_{i<k} 0.75 * 4^i
    return prefilter / s2 + _BSPLINE_VAR


def _gauss_table(sigma: float) -> tuple[np.ndarray, int]:
    """Unit-sum 1D Gaussian over [-r, r], r = ceil(3 sigma); index by |d|."""
    if sigma <= 0.0:
        return np.ones(1, dtype=np.float64), 0
    r = math.ceil(SUPPORT * sigma)
    d = np.arange(r + 1, dtype=np.float64)
    t = np.exp(-(d * d) / (2.0 * sigma * sigma))
    t /= t[0] + 2.0 * t[1:].sum()
    return t, r


@functools.lru_cache(maxsize=8)
def build_spec(radius: float) -> dict[str, Any]:
    """Everything the kernel and the reference share, for one radius. Cached
    by radius (a scrub repeats it); the result is read-only.

    Plane values are 8-bit (the driver plane arrives as u8 / 255), so every
    per-pixel quantity is a lookup by plane value `v` in 0..255.
    """
    sigmas = [_sigma_of(v, radius) for v in range(256)]
    klass = np.array([_klass_of(s) for s in sigmas], dtype=np.uint8)
    levels = int(klass.max()) + 1

    # Crossfade: a class-k pixel (k >= 1) with sigma below FADE_BAND times
    # its level's floor is also computed at level k-1. fade = weight of the
    # level-k result; 1 means no crossfade.
    fade = np.ones(256, dtype=np.float32)
    for v, s in enumerate(sigmas):
        k = int(klass[v])
        if k >= 1:
            floor = 2.0 * LEVEL_LOW * 2.0 ** (k - 1)
            t = (s / floor - 1.0) / (FADE_BAND - 1.0)
            if t < 1.0:
                fade[v] = np.float32(t)
    unfade = (np.float32(1.0) - fade).astype(np.float32)

    tables: list[np.ndarray] = []
    radii: list[np.ndarray] = []
    for k in range(levels):
        scale2 = float(4**k)
        extra = _level_extra_var(k)
        rows = []
        rs = np.zeros(256, dtype=np.int32)
        for v, s in enumerate(sigmas):
            var = s * s / scale2 - extra
            t, r = _gauss_table(math.sqrt(var) if var > 0.0 else 0.0)
            rows.append(t)
            rs[v] = r
        width = int(rs.max()) + 1
        table = np.zeros((256, width), dtype=np.float32)
        for v, t in enumerate(rows):
            table[v, : len(t)] = t.astype(np.float32)
        tables.append(table)
        radii.append(rs)

    bspline: list[np.ndarray] = [np.ones((1, 4), dtype=np.float32)]
    for k in range(1, levels):
        s = 2**k
        rows = []
        for m in range(s):
            f = ((2 * m + 1 - s) % (2 * s)) / (2.0 * s)
            rows.append(
                [
                    (1.0 - f) ** 3 / 6.0,
                    (3.0 * f**3 - 6.0 * f**2 + 4.0) / 6.0,
                    (-3.0 * f**3 + 3.0 * f**2 + 3.0 * f + 1.0) / 6.0,
                    f**3 / 6.0,
                ]
            )
        bspline.append(np.array(rows, dtype=np.float32))

    return {
        "levels": levels,
        "noise_step": NOISE_STEP,
        "noise_share": NOISE_SHARE,
        "denoise_passes": DENOISE_PASSES,
        "klass": klass,
        "fade": fade,
        "unfade": unfade,
        "tables": tables,
        "radii": radii,
        "bspline": bspline,
    }


# --- reference ---------------------------------------------------------------


def _looks_noisy(v: np.ndarray, step: int, share: float) -> bool:
    h, w = v.shape
    if w < 2 or h < 2:
        return False
    rows = np.arange(0, h - 1, 5)
    a = v[rows, :-1].astype(np.int32)
    right = v[rows, 1:].astype(np.int32)
    below = v[rows + 1, :-1].astype(np.int32)
    hits = int(((np.abs(a - right) > step) & (np.abs(a - below) > step)).sum())
    return hits > share * (len(rows) * (w - 1))


def _median3(v: np.ndarray) -> np.ndarray:
    """3x3 median, edges replicated."""
    h, w = v.shape
    p = np.pad(v, 1, mode="edge")
    stack = [p[dy : dy + h, dx : dx + w] for dy in range(3) for dx in range(3)]
    return np.median(np.stack(stack), axis=0).astype(np.uint8)


def denoise_plane(v: np.ndarray, spec: dict[str, Any]) -> np.ndarray:
    """What the kernel does to the plane before anything else: while it looks
    speckled, up to `denoise_passes` times, a 3x3 median. A median keeps a step
    edge where it is, so a near object stays as sharp as drawn, and it drops
    single-pixel speckle, which would otherwise put every pixel of the picture
    at a different pyramid level. A map without speckle is left alone."""
    for _ in range(spec["denoise_passes"]):
        if not _looks_noisy(v, spec["noise_step"], spec["noise_share"]):
            break
        v = _median3(v)
    return v


_F32 = np.float32
_THREE = np.float32(3.0)
_EIGHTH = np.float32(0.125)


def _down_axis(x: np.ndarray, axis: int) -> np.ndarray:
    """2x downsample along `axis` with [1,3,3,1]/8; samples past the edge are 0."""
    n = x.shape[axis]
    m = (n + 1) // 2
    pad = [(0, 0)] * x.ndim
    pad[axis] = (1, 2 * m + 1 - n)
    xp = np.pad(x, pad)

    def take(offset: int) -> np.ndarray:
        idx = [slice(None)] * x.ndim
        idx[axis] = slice(offset, offset + 2 * m, 2)
        return xp[tuple(idx)]

    return ((take(0) + take(1) * _THREE) + take(2) * _THREE + take(3)) * _EIGHTH


def _down(x: np.ndarray) -> np.ndarray:
    return _down_axis(_down_axis(x, 1), 0)


def _shift(a: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """out[y, x] = a[y + dy, x + dx], zero outside."""
    h, w = a.shape[:2]
    out = np.zeros_like(a)
    ys, ye = max(0, -dy), min(h, h - dy)
    xs, xe = max(0, -dx), min(w, w - dx)
    if ys < ye and xs < xe:
        out[ys:ye, xs:xe] = a[ys + dy : ye + dy, xs + dx : xe + dx]
    return out


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    """Chebyshev dilation by r cells."""
    if r <= 0:
        return mask.copy()
    out = mask.copy()
    for _ in range(r):
        grown = out.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                grown |= _shift(out, dy, dx)
        out = grown
    return out


def _vbar(planes: np.ndarray) -> np.ndarray:
    """Plane value of each cell: rint(sum v*cov / sum cov), 0 where empty."""
    cov = planes[..., 3]
    with np.errstate(invalid="ignore", divide="ignore"):
        vb = np.where(cov > 0, planes[..., 4] / np.where(cov > 0, cov, _F32(1)), 0)
    return np.rint(vb.astype(np.float32)).astype(np.int32)


def _fill_v(v: np.ndarray, valid: np.ndarray, passes: int = 3) -> np.ndarray:
    """Give empty cells the rounded mean plane value of their filled
    8-neighbours, `passes` times (Jacobi); still-empty cells get 255."""
    v = v.copy()
    valid = valid.copy()
    for _ in range(passes):
        total = np.zeros(v.shape, dtype=np.float32)
        count = np.zeros(v.shape, dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                sv = _shift(np.where(valid, v, 0).astype(np.float32), dy, dx)
                sc = _shift(valid.astype(np.float32), dy, dx)
                total = total + sv
                count = count + sc
        grow = (~valid) & (count > 0)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.rint(total / np.where(count > 0, count, _F32(1)))
        v = np.where(grow, mean.astype(np.int32), v)
        valid = valid | grow
    return np.where(valid, v, 255)


def _gather(
    points_v: np.ndarray,
    src: np.ndarray,
    src_v: np.ndarray,
    table: np.ndarray,
    radii: np.ndarray,
    min_rule: bool,
) -> np.ndarray:
    """Sum of w * src over offsets in raster order (dy, then dx), w from the
    level's table at m = min(v_p, v_q) (`min_rule`) or v_q (scatter of one
    class). Circle cut at the table's radius for m. Returns (h, w, 4):
    premultiplied r, g, b and the weight sum."""
    h, w = points_v.shape
    acc = np.zeros((h, w, 4), dtype=np.float32)
    rmax = int(radii.max())
    r2 = (radii * radii).astype(np.int64)
    for dy in range(-rmax, rmax + 1):
        for dx in range(-rmax, rmax + 1):
            sv = _shift(src_v, dy, dx)
            m = np.minimum(points_v, sv) if min_rule else sv
            wgt = table[m, abs(dx)] * table[m, abs(dy)]
            wgt = np.where(dy * dy + dx * dx <= r2[m], wgt, _F32(0)).astype(np.float32)
            s = _shift(src, dy, dx)
            for c in range(4):
                acc[..., c] = acc[..., c] + wgt * s[..., c]
    return acc


def _upsample(level: np.ndarray, k: int, h: int, w: int, bs: np.ndarray) -> np.ndarray:
    """Cubic B-spline from level k to (h, w); taps clamp at the edges."""
    if k == 0:
        return level
    s = 2**k
    lh, lw = level.shape[:2]
    ys = np.arange(h)
    xs = np.arange(w)
    by = np.floor_divide(2 * ys + 1 - s, 2 * s) - 1
    bx = np.floor_divide(2 * xs + 1 - s, 2 * s) - 1
    wy = bs[ys % s]  # (h, 4)
    wx = bs[xs % s]  # (w, 4)
    out = np.zeros((h, w) + level.shape[2:], dtype=np.float32)
    for iy in range(4):
        yi = np.clip(by + iy, 0, lh - 1)
        row = np.zeros((h, w) + level.shape[2:], dtype=np.float32)
        for ix in range(4):
            xi = np.clip(bx + ix, 0, lw - 1)
            vals = level[yi][:, xi]
            row = row + wx[None, :, ix, None] * vals
        out = out + wy[:, None, iy, None] * row
    return out


def driven_blur_reference(
    rgb: np.ndarray, v: np.ndarray, spec: dict[str, Any]
) -> np.ndarray:
    """NumPy reference: (h, w, 3) uint8 RGB and (h, w) uint8 plane values
    -> blurred (h, w, 3) uint8. Same maths and float32 order as the kernel."""
    v = denoise_plane(v, spec)
    h, w = v.shape
    levels = spec["levels"]
    klass_of = spec["klass"]
    tables = spec["tables"]
    radii = spec["radii"]
    bsp = spec["bspline"]
    v = v.astype(np.int32)
    klass = klass_of[v].astype(np.int32)

    base = np.zeros((h, w, 5), dtype=np.float32)
    base[..., :3] = rgb.astype(np.float32)
    base[..., 3] = 1.0
    base[..., 4] = v.astype(np.float32)

    # Per-class chains E_j^(r), r = 0..j.
    chains: list[list[np.ndarray]] = []
    for j in range(levels):
        e = np.where((klass == j)[..., None], base, _F32(0)).astype(np.float32)
        chain = [e]
        for _ in range(j):
            chain.append(_down(chain[-1]))
        chains.append(chain)
    # A_k = sum_{j >= k} E_j^(k), ascending j (A_0 is the image itself).
    big_a: list[np.ndarray] = [base]
    for k in range(1, levels):
        a = chains[k][k]
        for j in range(k + 1, levels):
            a = a + _down_k(chains[j], k)
        big_a.append(a)

    # F_k and S_j at every point of their level (the kernel computes only
    # the points it reads; unread points don't matter, unreachable ones are 0).
    f_levels: list[np.ndarray] = []
    for k in range(levels):
        a = big_a[k]
        if k == 0:
            pv = v
            sv = v
        else:
            vb = _vbar(a)
            sv = vb
            pv = _fill_v(vb, a[..., 3] > 0)
        src = a[..., :4]
        f_levels.append(_gather(pv, src, sv, tables[k], radii[k], min_rule=True))
    s_levels: list[np.ndarray] = []
    for j in range(levels - 1):
        e = chains[j][j]
        sv = v if j == 0 else _vbar(e)
        s_levels.append(
            _gather(sv, e[..., :4], sv, tables[j], radii[j], min_rule=False)
        )

    up_f = [_upsample(f_levels[k], k, h, w, bsp[k]) for k in range(levels)]
    up_s = [_upsample(s_levels[j], j, h, w, bsp[j]) for j in range(levels - 1)]

    def colour_at(k: int) -> np.ndarray:
        acc = np.zeros((h, w, 4), dtype=np.float32)
        for j in range(k):
            acc = acc + up_s[j]
        acc = acc + up_f[k]
        den = acc[..., 3:4]
        return acc[..., :3] / np.where(den > 0, den, _F32(1))

    out = np.zeros((h, w, 3), dtype=np.float32)
    fade = spec["fade"][v][..., None]
    unfade = spec["unfade"][v][..., None]
    for k in range(levels):
        sel = klass == k
        if not sel.any():
            continue
        ck = colour_at(k)
        if k >= 1:
            fading = sel & (spec["fade"][v] < 1.0)
            if fading.any():
                cf = colour_at(k - 1)
                blended = cf * unfade + ck * fade
                ck = np.where(fading[..., None], blended, ck)
        out = np.where(sel[..., None], ck, out)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def _down_k(chain: list[np.ndarray], k: int) -> np.ndarray:
    return chain[k]
