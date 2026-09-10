"""Colour-range (magic wand) selection. Pure NumPy, no scipy — see
`handlers/select_colour.py` for the request/response shape and
`design/shared-vision-kit.md` for why `ml/` stays protocol-free.

Pipeline, per seed (one seed = one call — the handler combines multiple
seeds, see its own docstring): threshold a per-pixel colour distance to the
seed's own colour (opaque pixels only) -> optionally restrict to the seed's
4-connected component (`contiguous: true`) -> a separable box dilate/erode
(`expand`) -> drop foreground components under `min_island` px. That order
matters and is fixed on purpose:

- The contiguous filter runs on the RAW (pre-expand) threshold mask. Doing
  it after `expand` would let a dilate bridge two originally-disjoint blobs
  together and pull in a region the seed never actually touched.
- `min_island` runs LAST, after `expand`, because an erode (`expand < 0`)
  can splinter one component into several crumb-sized pieces that only
  exist post-erosion — `min_island` has to see the eroded shape to sweep
  them.
- `min_island` drops small FOREGROUND components only; it is computed
  post-expand on whatever `contiguous`/global selection produced, not
  applied to holes (there are none at this stage — holes only appear once
  `trace.py` traces the boolean mask this module returns).
"""

from __future__ import annotations

import numpy as np

Space = str  # 'lab' | 'rgb'

# --- sRGB -> Lab (D65), vectorised -----------------------------------------

_LAB_GAMMA_THRESHOLD = 0.04045
_LAB_EPSILON = (6.0 / 29.0) ** 3
_LAB_KAPPA = 1.0 / (3.0 * (6.0 / 29.0) ** 2)

_XYZ_MATRIX = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float32,
)

_D65_WHITE = np.array([0.95047, 1.0, 1.08883], dtype=np.float32)


def _srgb_to_linear_lut() -> np.ndarray:
    """256-entry LUT, `uint8` channel value -> linear-light float — the
    input is always `uint8`, so a lookup table replaces a `**2.4` power
    over every pixel (the difference between a ~0.1s and a multi-second
    2048^2 request).
    """
    c = np.arange(256, dtype=np.float64) / 255.0
    linear = np.where(
        c <= _LAB_GAMMA_THRESHOLD, c / 12.92, ((c + 0.055) / 1.055) ** 2.4
    )
    return linear.astype(np.float32)


_SRGB_TO_LINEAR = _srgb_to_linear_lut()


def _rgb_to_lab(rgb_u8: np.ndarray) -> np.ndarray:
    """sRGB `uint8` `(..., 3)` -> CIE Lab `(..., 3)` `float32`, D65 white
    point. sRGB -> linear via `_SRGB_TO_LINEAR`; linear -> XYZ via the
    standard sRGB primaries matrix; XYZ -> Lab via the usual piecewise
    cube-root `f(t)`, vectorised (`np.where`, not a Python branch).
    """
    linear = _SRGB_TO_LINEAR[rgb_u8]  # fancy-indexing LUT application
    xyz = linear @ _XYZ_MATRIX.T
    xyz_n = xyz / _D65_WHITE

    def f(t: np.ndarray) -> np.ndarray:
        return np.where(t > _LAB_EPSILON, np.cbrt(t), _LAB_KAPPA * t + 4.0 / 29.0)

    fx = f(xyz_n[..., 0])
    fy = f(xyz_n[..., 1])
    fz = f(xyz_n[..., 2])

    lightness = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([lightness, a, b], axis=-1).astype(np.float32)


# --- 4-connected component labelling, run-based (no scipy) ----------------


def _row_runs(match: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Every maximal horizontal run of `True` in `match` (H, W), as three
    parallel arrays `(row, c0, c1)` (`c1` exclusive), fully vectorised. A
    `False` sentinel column is appended so a run can never cross a row
    boundary once the array is raveled — a padding trick, not a loop.
    """
    h, w = match.shape
    padded = np.zeros((h, w + 1), dtype=bool)
    padded[:, :w] = match
    flat = padded.ravel()
    d = np.diff(flat.astype(np.int8), prepend=np.int8(0))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    row = starts // (w + 1)
    c0 = starts - row * (w + 1)
    c1 = ends - row * (w + 1)
    return row, c0, c1


def _connected_components(
    match: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """4-connected component labelling of a boolean `(H, W)` array via
    horizontal run-length encoding + union-find over RUNS, not pixels — a
    two-pass connected-component scheme (cf. `scipy.ndimage.label`,
    reimplemented here because `ml/` is scipy-free per this epic's decision).
    A component that fills most of a 4096^2 frame still costs ~one run per
    row (~thousands, not millions), so this stays well under a second even
    on a fully-selected image — a per-pixel flood fill or a wavefront BFS
    does not (measured: a naive 1px-per-iteration wavefront is 10s+ on a
    single filled 2048^2 region).

    Returns `(row, c0, c1, root)`, one entry per run: `root` is a union-find
    root index into these SAME arrays — two runs share a component iff
    their `root` matches. Adjacent-row overlap is found via `searchsorted`
    on each row's own sorted, disjoint runs (a merge, not a nested scan),
    so total work is `O(total runs)`.
    """
    h = match.shape[0]
    row, c0, c1 = _row_runs(match)
    n = len(row)
    if n == 0:
        return row, c0, c1, np.empty(0, dtype=np.int64)

    parent = np.arange(n)

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    row_start = np.searchsorted(row, np.arange(h + 1))
    for r in range(h - 1):
        cur_lo, cur_hi = int(row_start[r]), int(row_start[r + 1])
        nxt_lo, nxt_hi = int(row_start[r + 1]), int(row_start[r + 2])
        if cur_lo == cur_hi or nxt_lo == nxt_hi:
            continue
        nxt_c0 = c0[nxt_lo:nxt_hi]
        nxt_c1 = c1[nxt_lo:nxt_hi]
        for i in range(cur_lo, cur_hi):
            s, e = int(c0[i]), int(c1[i])
            # Runs in the next row are sorted + disjoint, so both bounds of
            # the overlap window are a single searchsorted each: c1 > s is
            # a suffix (c1 ascending), c0 < e is a prefix (c0 ascending).
            lo = nxt_lo + int(np.searchsorted(nxt_c1, s, side="right"))
            hi = nxt_lo + int(np.searchsorted(nxt_c0, e, side="left"))
            for j in range(lo, hi):
                union(i, j)

    root = np.array([find(i) for i in range(n)])
    return row, c0, c1, root


def _paint_runs(
    shape: tuple[int, int], row: np.ndarray, c0: np.ndarray, c1: np.ndarray
) -> np.ndarray:
    out = np.zeros(shape, dtype=bool)
    for r, s, e in zip(row.tolist(), c0.tolist(), c1.tolist()):
        out[r, s:e] = True
    return out


def _seed_component_mask(match: np.ndarray, seed_row: int, seed_col: int) -> np.ndarray:
    """Restrict `match` to the 4-connected component containing
    `(seed_row, seed_col)` — empty if the seed pixel itself doesn't match
    (`contiguous: true`'s whole point: a click on a non-matching pixel
    selects nothing, it doesn't fall back to global).
    """
    if not match[seed_row, seed_col]:
        return np.zeros_like(match)

    row, c0, c1, root = _connected_components(match)
    row_start = np.searchsorted(row, np.arange(match.shape[0] + 1))
    r0, r1 = int(row_start[seed_row]), int(row_start[seed_row + 1])
    seed_run = next(i for i in range(r0, r1) if c0[i] <= seed_col < c1[i])
    keep = root == root[seed_run]
    return _paint_runs(match.shape, row[keep], c0[keep], c1[keep])


def _filter_by_min_island(match: np.ndarray, min_island: float) -> np.ndarray:
    """Drop foreground components under `min_island` px area. No-op for
    `min_island <= 0`; an all-`False` mask short-circuits (nothing to run
    CCL over).
    """
    if min_island <= 0 or not match.any():
        return match
    row, c0, c1, root = _connected_components(match)
    lengths = (c1 - c0).astype(np.float64)
    areas = np.bincount(root, weights=lengths, minlength=len(root))
    keep = areas[root] >= min_island
    return _paint_runs(match.shape, row[keep], c0[keep], c1[keep])


# --- separable box dilate / erode ------------------------------------------


def _box_pass_1d(mask: np.ndarray, radius: int, axis: int, dilate: bool) -> np.ndarray:
    n = mask.shape[axis]
    window = 2 * radius + 1
    pad_width = [(0, 0), (0, 0)]
    pad_width[axis] = (radius, radius)
    # Out-of-frame counts as background for both directions — an erode
    # pulls a selection touching the image edge inward rather than treating
    # the edge as an implicit wall (same "pad with False" convention
    # trace.py uses so shapes touching the border still close correctly).
    padded = np.pad(
        mask.astype(np.int32), pad_width, mode="constant", constant_values=0
    )
    csum = np.cumsum(padded, axis=axis)
    zeros_shape = list(csum.shape)
    zeros_shape[axis] = 1
    csum = np.concatenate([np.zeros(zeros_shape, dtype=csum.dtype), csum], axis=axis)
    sl_hi: list[slice] = [slice(None), slice(None)]
    sl_lo: list[slice] = [slice(None), slice(None)]
    sl_hi[axis] = slice(window, window + n)
    sl_lo[axis] = slice(0, n)
    window_sum = csum[tuple(sl_hi)] - csum[tuple(sl_lo)]
    return window_sum > 0 if dilate else window_sum >= window


def _box_expand(mask: np.ndarray, expand: int) -> np.ndarray:
    """Separable box dilate (`expand > 0`) / erode (`expand < 0`) by
    `abs(expand)` px, one axis at a time — an `O(N)` cumulative-sum sliding
    window per axis (the story's own "separable box pass"), not a loop over
    window offsets, so cost doesn't grow with radius.
    """
    if expand == 0:
        return mask
    radius = abs(expand)
    dilate = expand > 0
    out = mask
    for axis in (0, 1):
        out = _box_pass_1d(out, radius, axis, dilate)
    return out


# --- the public entry point -------------------------------------------------


def select_colour(
    rgba: np.ndarray,
    seed: tuple[int, int],
    *,
    tolerance: int,
    contiguous: bool,
    space: Space,
    expand: int,
    min_island: int,
) -> np.ndarray:
    """Flood-fill-by-colour `rgba` (H, W, 4) `uint8` from `seed = (x, y)`
    (pixel-space, same x/y convention as everywhere else in the sidecar).

    Distance is Euclidean in the chosen `space` ('lab' — perceptual, default
    for the caller; or 'rgb' — cheaper, raw ink distance), normalised to a
    0..255 scale as the ROOT-MEAN-SQUARE of the per-channel differences
    (not a raw 3-channel Euclidean sum, whose max exceeds 255 for RGB) so
    `tolerance` means the same 0..255 slider in both spaces and its two
    documented extremes hold exactly: `tolerance=0` keeps only pixels whose
    RMS channel difference from the seed is exactly zero (bit-identical in
    that space); `tolerance=255` is >= the RMS-normalised max possible
    distance in either space, so every opaque pixel matches. Alpha is
    ignored for the distance itself but gates matching — a fully transparent
    pixel never matches, seed included.

    Returns an `(H, W)` bool mask. See the module docstring for why
    threshold -> contiguous -> expand -> min_island is the fixed order.
    """
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError(
            f"select_colour expects an (H, W, 4) RGBA array, got shape {rgba.shape}"
        )
    if space not in ("lab", "rgb"):
        raise ValueError(f"space must be 'lab' or 'rgb', got {space!r}")

    seed_x, seed_y = seed
    h, w = rgba.shape[:2]
    if not (0 <= seed_x < w and 0 <= seed_y < h):
        raise ValueError(f"seed ({seed_x}, {seed_y}) is outside the {w}x{h} frame")

    alpha_ok = rgba[..., 3] > 0
    channels = (
        _rgb_to_lab(rgba[..., :3])
        if space == "lab"
        else rgba[..., :3].astype(np.float32)
    )

    seed_colour = channels[seed_y, seed_x]
    diff = channels - seed_colour
    # Mean of squared per-channel diffs == (RMS distance)^2 — comparing this
    # directly to tolerance**2 is exact and skips a sqrt over every pixel.
    mean_sq_diff = np.mean(diff * diff, axis=-1)

    match = alpha_ok & (mean_sq_diff <= float(tolerance) ** 2)

    if contiguous:
        match = _seed_component_mask(match, seed_y, seed_x)

    match = _box_expand(match, expand)
    match = _filter_by_min_island(match, float(min_island))

    return match
