import { describe, expect, it } from 'vitest';
import {
  appendLassoPoint,
  closedPolylinePath,
  ellipsePath,
  isDrawnLasso,
  isDrawnRect,
  isNearStart,
  lassoBounds,
  moveRect,
  normalizeRect,
  rectContains,
  rectCorners,
  rectFromDrag,
  rectHandlePositions,
  resizeRect,
  translatePoints,
} from './marqueeGeometry';

describe('normalizeRect', () => {
  it('handles corners given in any order', () => {
    expect(normalizeRect(10, 10, 0, 0)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(normalizeRect(0, 0, 10, 10)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('rectFromDrag', () => {
  it('plain drag: anchor is a corner, box spans anchor -> current', () => {
    const rect = rectFromDrag(
      { x: 10, y: 20 },
      { x: 60, y: 50 },
      { square: false, fromCentre: false },
    );
    expect(rect).toEqual({ x: 10, y: 20, w: 50, h: 30 });
  });

  it('square (Shift): constrains to equal width/height from the anchor corner', () => {
    const rect = rectFromDrag(
      { x: 0, y: 0 },
      { x: 100, y: 40 },
      { square: true, fromCentre: false },
    );
    expect(rect.w).toBe(rect.h);
    expect(rect.w).toBe(100);
  });

  it('fromCentre (Alt): anchor is the box centre, box grows symmetrically', () => {
    const rect = rectFromDrag(
      { x: 50, y: 50 },
      { x: 80, y: 60 },
      { square: false, fromCentre: true },
    );
    expect(rect).toEqual({ x: 20, y: 40, w: 60, h: 20 });
  });

  it('fromCentre + square: symmetric circle/square around the anchor', () => {
    const rect = rectFromDrag(
      { x: 50, y: 50 },
      { x: 80, y: 55 },
      { square: true, fromCentre: true },
    );
    expect(rect.w).toBe(rect.h);
    // dx=30, dy=5 -> m=30, box spans anchor +/- 30 on both axes.
    expect(rect).toEqual({ x: 20, y: 20, w: 60, h: 60 });
  });
});

describe('moveRect', () => {
  it('translates by a document-space delta, keeping size', () => {
    const rect = { x: 10, y: 10, w: 40, h: 20 };
    expect(moveRect(rect, { x: 5, y: -3 })).toEqual({ x: 15, y: 7, w: 40, h: 20 });
  });
});

describe('resizeRect', () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 };

  it('se corner: opposite corner (nw, at 0,0) stays fixed', () => {
    const next = resizeRect(rect, 'se', { x: 150, y: 80 }, false);
    expect(next).toEqual({ x: 0, y: 0, w: 150, h: 80 });
  });

  it('nw corner: opposite corner (se, at 100,50) stays fixed', () => {
    const next = resizeRect(rect, 'nw', { x: -20, y: -10 }, false);
    expect(next).toEqual({ x: -20, y: -10, w: 120, h: 60 });
  });

  it('edge handle e: only width changes, height fixed', () => {
    const next = resizeRect(rect, 'e', { x: 200, y: 999 }, false);
    expect(next).toEqual({ x: 0, y: 0, w: 200, h: 50 });
  });

  it('edge handle n: only height changes, width fixed', () => {
    const next = resizeRect(rect, 'n', { x: 999, y: -30 }, false);
    expect(next).toEqual({ x: 0, y: -30, w: 100, h: 80 });
  });

  it('square (Shift) on a corner: both axes snap to the larger magnitude', () => {
    const next = resizeRect(rect, 'se', { x: 300, y: 120 }, true);
    expect(next.w).toBe(next.h);
    expect(next.w).toBe(300);
  });

  it('dragging past the fixed corner still normalizes to a positive rect', () => {
    const next = resizeRect(rect, 'se', { x: -50, y: -20 }, false);
    expect(next).toEqual({ x: -50, y: -20, w: 50, h: 20 });
  });
});

describe('rectHandlePositions / rectCorners — axis-aligned, no rotation', () => {
  const rect = { x: 10, y: 20, w: 100, h: 50 };

  it('corners sit exactly on the rect bounds', () => {
    expect(rectCorners(rect)).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 70 },
      { x: 10, y: 70 },
    ]);
  });

  it('se handle sits at the bottom-right corner', () => {
    expect(rectHandlePositions(rect).se).toEqual({ x: 110, y: 70 });
  });

  it('n handle sits at the top-centre', () => {
    expect(rectHandlePositions(rect).n).toEqual({ x: 60, y: 20 });
  });

  it('has no rotate handle (marquees don’t rotate)', () => {
    expect((rectHandlePositions(rect) as Record<string, unknown>).rotate).toBeUndefined();
  });
});

describe('rectContains', () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 };
  it('true inside, false outside', () => {
    expect(rectContains(rect, { x: 50, y: 25 })).toBe(true);
    expect(rectContains(rect, { x: 150, y: 25 })).toBe(false);
  });
});

describe('isDrawnRect — guards against a stray click leaving a degenerate marquee', () => {
  it('false for a zero-size rect (a plain click, never dragged)', () => {
    expect(isDrawnRect({ x: 10, y: 10, w: 0, h: 0 })).toBe(false);
  });

  it('true once the drag has moved the box to a real size', () => {
    expect(isDrawnRect({ x: 10, y: 10, w: 20, h: 20 })).toBe(true);
  });
});

describe('isDrawnLasso — same guard for the freehand path', () => {
  it('false below the minimum point count (a click or a two-point flick)', () => {
    expect(isDrawnLasso([{ x: 0, y: 0 }])).toBe(false);
    expect(
      isDrawnLasso([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBe(false);
  });

  it('true once the path has enough points to be a real shape', () => {
    expect(
      isDrawnLasso([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe(true);
  });
});

describe('lasso helpers', () => {
  it('appendLassoPoint grows the path without mutating the input', () => {
    const points = [{ x: 0, y: 0 }];
    const next = appendLassoPoint(points, { x: 5, y: 5 });
    expect(next).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
    expect(points).toEqual([{ x: 0, y: 0 }]);
  });

  it('isNearStart is threshold-based, independent of any view scale', () => {
    const start = { x: 100, y: 100 };
    expect(isNearStart({ x: 102, y: 101 }, start, 5)).toBe(true);
    expect(isNearStart({ x: 200, y: 200 }, start, 5)).toBe(false);
  });

  it('translatePoints moves every point by the same delta', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(translatePoints(points, { x: 2, y: 3 })).toEqual([
      { x: 2, y: 3 },
      { x: 12, y: 13 },
    ]);
  });

  it('lassoBounds returns the bounding box of the path', () => {
    const points = [
      { x: 5, y: 10 },
      { x: -5, y: 20 },
      { x: 15, y: 0 },
    ];
    expect(lassoBounds(points)).toEqual({ x: -5, y: 0, w: 20, h: 20 });
  });

  it('lassoBounds is zero-size for an empty path', () => {
    expect(lassoBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('marquee geometry survives pan/zoom (document-space, no view transform involved)', () => {
  it('the same rect and handle positions come out regardless of any view state', () => {
    // Nothing in this module imports or reads ViewTransform — a document-space
    // rect drawn at one zoom level produces identical handle/corner geometry
    // at any other, because the inputs here are pure document coordinates.
    const rect = rectFromDrag(
      { x: 20, y: 20 },
      { x: 120, y: 70 },
      { square: false, fromCentre: false },
    );
    const corners = rectCorners(rect);
    const handles = rectHandlePositions(rect);
    expect(rect).toEqual({ x: 20, y: 20, w: 100, h: 50 });
    expect(corners[2]).toEqual({ x: 120, y: 70 });
    expect(handles.se).toEqual({ x: 120, y: 70 });
  });
});

describe('closedPolylinePath / ellipsePath (selection fill)', () => {
  it('closes a polygon, and is empty for no points', () => {
    expect(
      closedPolylinePath([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
      ]),
    ).toBe('M0,0 L4,0 L4,2 Z');
    expect(closedPolylinePath([])).toBe('');
  });

  it('draws the inscribed ellipse as two half-turn arcs', () => {
    expect(ellipsePath({ x: 10, y: 20, w: 100, h: 50 })).toBe(
      'M10,45 A50,25 0 1 0 110,45 A50,25 0 1 0 10,45 Z',
    );
  });
});
