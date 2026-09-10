"""Mask -> closed polygon tracing. Pure NumPy, no scipy/skimage.

Pipeline: marching squares over the thresholded boolean mask (corners
sampled at pixel centres, contour at the 0/1 midlevel, one pixel of False
padding around the mask so shapes touching the image edge still close) ->
stitch the per-cell edge segments into closed loops via an undirected
adjacency walk (direction-agnostic — no case-table winding to get wrong) ->
classify each loop as an outer contour or a hole by testing, at one edge,
whether the mask-foreground side lands inside or outside the loop -> drop
loops under `min_area` -> Douglas-Peucker simplify each loop at `epsilon`.

Coordinates: crossing points sit at the mid-point between two pixel
centres, i.e. half-integer (row, col). Returned polygons are (x, y) =
(col, row), matching the sidecar's usual x/y convention.
"""

from __future__ import annotations

import math

import numpy as np

Point = tuple[float, float]


def trace_mask(
    mask: np.ndarray,
    *,
    epsilon: float = 1.0,
    min_area: float = 16.0,
    keep_holes: bool = False,
) -> list[list[Point]]:
    """Trace `mask` (H, W) bool into closed (x, y) polygons.

    Outer contours only by default; pass `keep_holes=True` to also get the
    boundaries of background regions enclosed by foreground (needed by
    colour-range-select's story later — accepted but unused here).
    """
    mask = np.asarray(mask, dtype=bool)
    if mask.ndim != 2:
        raise ValueError(f"trace_mask expects a 2D mask, got shape {mask.shape}")

    padded = np.zeros((mask.shape[0] + 2, mask.shape[1] + 2), dtype=bool)
    padded[1:-1, 1:-1] = mask

    segments, fg_samples = _build_segments(padded)
    loops = _stitch_loops(segments, fg_samples)

    polygons: list[list[Point]] = []
    for loop, fg_sample in loops:
        if len(loop) < 3:
            continue
        if _polygon_area(loop) < min_area:
            continue
        if not keep_holes and not _point_in_polygon(fg_sample, loop):
            continue
        simplified = _rdp_closed(loop, epsilon)
        if len(simplified) < 3:
            continue
        polygons.append([(col, row) for row, col in simplified])
    return polygons


def _build_segments(
    padded: np.ndarray,
) -> tuple[list[tuple[Point, Point]], list[Point]]:
    """One marching-squares pass over `padded`, returning undirected segments
    plus, per segment, one lattice point (a cell corner, exact integer
    coordinates) known to be foreground — used later to tell an outer
    contour from a hole without any direction/winding bookkeeping.

    `padded[i, j]` is corner `a` of cell `(i, j)`; corners b/c/d are its
    row/col neighbours. Edges T/R/B/L are the four cell edges; a crossing
    exists wherever its two corners differ. Two crossings -> one segment;
    four (the saddle cases, diagonal corners equal and opposite each other)
    -> two segments, resolved by a fixed (not direction-derived) tie-break.
    """
    a = padded[:-1, :-1]
    b = padded[:-1, 1:]
    c = padded[1:, 1:]
    d = padded[1:, :-1]

    t_cross = a != b
    r_cross = b != c
    bo_cross = d != c
    l_cross = a != d
    any_cross = t_cross | r_cross | bo_cross | l_cross

    segments: list[tuple[Point, Point]] = []
    fg_samples: list[Point] = []
    for i, j in zip(*np.nonzero(any_cross)):
        i = int(i)
        j = int(j)
        top: Point = (i - 1, j - 0.5)
        right: Point = (i - 0.5, j)
        bottom: Point = (i, j - 0.5)
        left: Point = (i - 0.5, j - 1)

        # Cell-corner positions, in the same (row, col) mask space as the
        # edge mid-points above — exact integers, never on a traced edge.
        a_pos: Point = (i - 1, j - 1)
        b_pos: Point = (i - 1, j)
        c_pos: Point = (i, j)
        d_pos: Point = (i, j - 1)
        fg_pos = next(
            pos
            for val, pos in (
                (a[i, j], a_pos),
                (b[i, j], b_pos),
                (c[i, j], c_pos),
                (d[i, j], d_pos),
            )
            if val
        )

        crossings = [
            (t_cross[i, j], top),
            (r_cross[i, j], right),
            (bo_cross[i, j], bottom),
            (l_cross[i, j], left),
        ]
        n_cross = sum(1 for hit, _ in crossings if hit)

        if n_cross == 2:
            pts = [pt for hit, pt in crossings if hit]
            segments.append((pts[0], pts[1]))
            fg_samples.append(fg_pos)
        elif n_cross == 4:
            # Saddle: a == c, b == d, a != b. Tie-break on corner `a` —
            # consistent and cheap; either resolution is topologically
            # valid for a binary field, this one just avoids bridging the
            # two diagonal corners into one blob.
            if a[i, j]:
                segments.append((left, top))
                fg_samples.append(a_pos)
                segments.append((right, bottom))
                fg_samples.append(c_pos)
            else:
                segments.append((top, right))
                fg_samples.append(b_pos)
                segments.append((bottom, left))
                fg_samples.append(d_pos)
        # n_cross in (0,) can't reach here (any_cross filtered it out);
        # n_cross in (1, 3) is impossible for a binary field (crossings
        # always come in a even count around a cell boundary).
    return segments, fg_samples


def _stitch_loops(
    segments: list[tuple[Point, Point]], fg_samples: list[Point]
) -> list[tuple[list[Point], Point]]:
    """Walk the undirected segment graph into closed point loops, each
    paired with one of its segments' known-foreground lattice points.

    No orientation bookkeeping: each interior contour point has degree 2,
    so following unvisited edges from any starting segment either returns
    to the start (a closed loop, kept) or runs out (a defensive drop —
    shouldn't happen for a binary field, but a malformed chain is worse
    than a missing polygon).
    """
    adjacency: dict[Point, list[int]] = {}
    for idx, (p1, p2) in enumerate(segments):
        adjacency.setdefault(p1, []).append(idx)
        adjacency.setdefault(p2, []).append(idx)

    visited = [False] * len(segments)
    loops: list[tuple[list[Point], Point]] = []

    for start_idx in range(len(segments)):
        if visited[start_idx]:
            continue
        visited[start_idx] = True
        start, current = segments[start_idx]
        fg_sample = fg_samples[start_idx]
        loop = [start]
        closed = False
        while True:
            if current == start:
                closed = True
                break
            loop.append(current)
            candidates = [i for i in adjacency.get(current, []) if not visited[i]]
            if not candidates:
                break
            next_idx = candidates[0]
            visited[next_idx] = True
            p1, p2 = segments[next_idx]
            current = p2 if p1 == current else p1
        if closed:
            loops.append((loop, fg_sample))
    return loops


def _polygon_area(loop: list[Point]) -> float:
    area = 0.0
    n = len(loop)
    for i in range(n):
        x1, y1 = loop[i]
        x2, y2 = loop[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def _point_in_polygon(pt: Point, poly: list[Point]) -> bool:
    """Standard PNPOLY ray-casting test (Franklin)."""
    x, y = pt
    inside = False
    x1, y1 = poly[-1]
    for x2, y2 in poly:
        if (y1 > y) != (y2 > y):
            x_at_y = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < x_at_y:
                inside = not inside
        x1, y1 = x2, y2
    return inside


def _perp_distance(p: Point, a: Point, b: Point) -> float:
    if a == b:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    ax, ay = a
    bx, by = b
    px, py = p
    num = abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax)
    den = math.hypot(by - ay, bx - ax)
    return num / den


def _rdp_open(points: list[Point], epsilon: float) -> list[Point]:
    if len(points) < 3:
        return points
    start, end = points[0], points[-1]
    max_dist = -1.0
    index = -1
    for i in range(1, len(points) - 1):
        dist = _perp_distance(points[i], start, end)
        if dist > max_dist:
            max_dist = dist
            index = i
    if max_dist > epsilon:
        left = _rdp_open(points[: index + 1], epsilon)
        right = _rdp_open(points[index:], epsilon)
        return left[:-1] + right
    return [start, end]


def _rdp_closed(points: list[Point], epsilon: float) -> list[Point]:
    """Douglas-Peucker on a closed loop: pick the point farthest from
    `points[0]` as a second anchor, simplify the two resulting open chains
    independently, then stitch them back together.
    """
    n = len(points)
    if n < 3:
        return points
    p0 = points[0]
    dists = [math.hypot(p[0] - p0[0], p[1] - p0[1]) for p in points]
    k = max(range(n), key=lambda i: dists[i])
    if k == 0:
        return points
    chain1 = points[: k + 1]
    chain2 = points[k:] + points[:1]
    simplified1 = _rdp_open(chain1, epsilon)
    simplified2 = _rdp_open(chain2, epsilon)
    merged = simplified1[:-1] + simplified2[:-1]
    return merged
