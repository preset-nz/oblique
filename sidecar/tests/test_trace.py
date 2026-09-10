"""`ml.trace.trace_mask` on synthetic masks: closed-loop shape, edge
roughness kept (Hausdorff bound), min-area drop, keep_holes.
"""

from __future__ import annotations

import numpy as np

from ml.trace import trace_mask


def _polygon_area(poly: list[tuple[float, float]]) -> float:
    area = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def _densify(poly: list[tuple[float, float]], step: float = 0.5) -> np.ndarray:
    """Resample a closed polygon's edges at ~`step` px spacing, so Hausdorff
    comparisons see the polygon's actual boundary (straight edges between
    vertices), not just its sparse vertex set.
    """
    pts: list[tuple[float, float]] = []
    arr = np.asarray(poly, dtype=float)
    n = len(arr)
    for i in range(n):
        p0, p1 = arr[i], arr[(i + 1) % n]
        seg_len = float(np.hypot(*(p1 - p0)))
        steps = max(1, int(seg_len / step))
        for t in np.linspace(0.0, 1.0, steps, endpoint=False):
            pts.append(tuple(p0 + t * (p1 - p0)))
    return np.array(pts)


def _directed_hausdorff(a: np.ndarray, b: np.ndarray) -> float:
    d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2)
    return float(np.sqrt(d2.min(axis=1)).max())


def _hausdorff(a: np.ndarray, b: np.ndarray) -> float:
    return max(_directed_hausdorff(a, b), _directed_hausdorff(b, a))


def test_square_traces_to_a_near_rectangular_polygon():
    mask = np.zeros((40, 40), dtype=bool)
    mask[10:30, 10:30] = True

    polygons = trace_mask(mask, epsilon=1.0, min_area=16)

    assert len(polygons) == 1
    poly = polygons[0]
    assert 4 <= len(poly) <= 8  # a clean square, DP should leave it near-4
    assert (
        _polygon_area([(y, x) for x, y in poly]) == 380.5
    )  # 20x20, inset by the mid-pixel contour convention


def test_polygons_are_closed_and_in_xy_order():
    mask = np.zeros((20, 20), dtype=bool)
    mask[5:15, 5:15] = True

    polygons = trace_mask(mask, epsilon=1.0, min_area=16)

    assert len(polygons) == 1
    for x, y in polygons[0]:
        assert 0.0 <= x <= 20.0
        assert 0.0 <= y <= 20.0


def test_min_area_drops_small_polygons():
    mask = np.zeros((40, 40), dtype=bool)
    mask[5:7, 5:7] = True  # 2x2 speck, well under the 16 px^2 floor

    polygons = trace_mask(mask, epsilon=1.0, min_area=16)

    assert polygons == []


def test_min_area_keeps_polygons_above_the_floor():
    mask = np.zeros((40, 40), dtype=bool)
    mask[10:20, 10:20] = True  # 10x10 = 100 px^2, comfortably above 16

    polygons = trace_mask(mask, epsilon=1.0, min_area=16)

    assert len(polygons) == 1


def test_keep_holes_false_returns_outer_contour_only():
    mask = np.zeros((50, 50), dtype=bool)
    mask[10:40, 10:40] = True
    mask[20:30, 20:30] = False  # a 10x10 hole in the middle

    polygons = trace_mask(mask, epsilon=1.0, min_area=16, keep_holes=False)

    assert len(polygons) == 1


def test_keep_holes_true_returns_outer_and_hole_contours():
    mask = np.zeros((50, 50), dtype=bool)
    mask[10:40, 10:40] = True
    mask[20:30, 20:30] = False

    polygons = trace_mask(mask, epsilon=1.0, min_area=16, keep_holes=True)

    assert len(polygons) == 2
    areas = sorted(_polygon_area([(y, x) for x, y in p]) for p in polygons)
    assert areas[0] < areas[1]  # the hole is smaller than the outer ring


def test_tracing_keeps_edge_roughness_within_hausdorff_bound():
    """A synthetic mask with a ~3 px-amplitude jagged boundary: the traced,
    DP-simplified polygon must stay within 1.5 px (Hausdorff) of the true
    jagged boundary — i.e. epsilon=1.0 must not have straightened it out.
    """
    height, width = 140, 140
    cy, cx = 70.0, 70.0
    base_radius = 40.0
    amplitude = 3.0
    frequency = 40

    yy, xx = np.mgrid[0:height, 0:width]
    theta = np.arctan2(yy - cy, xx - cx)
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    mask = r <= (base_radius + amplitude * np.sin(theta * frequency))

    polygons = trace_mask(mask, epsilon=1.0, min_area=16)
    assert len(polygons) == 1
    poly_dense = _densify(polygons[0])

    thetas = np.linspace(-np.pi, np.pi, 4000, endpoint=False)
    gt_r = base_radius + amplitude * np.sin(thetas * frequency)
    ground_truth = np.stack(
        [cx + gt_r * np.cos(thetas), cy + gt_r * np.sin(thetas)], axis=1
    )

    assert _hausdorff(poly_dense, ground_truth) <= 1.5


def test_same_mask_gives_byte_identical_polygons():
    mask = np.zeros((60, 60), dtype=bool)
    mask[15:45, 15:45] = True
    mask[25:35, 20:25] = False

    first = trace_mask(mask, epsilon=1.0, min_area=16)
    second = trace_mask(mask, epsilon=1.0, min_area=16)

    assert first == second
