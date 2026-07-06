import { describe, expect, it } from 'vitest';
import type { AnchorPoint, Point2D, VectorPath } from '@/scene/types';
import { cubicPointAt } from './bezier';
import {
  anchorMode,
  closestPointOnPaths,
  cycleAnchorMode,
  deleteAnchor,
  dragHandle,
  insertAnchorAt,
  moveAnchor,
  movePath,
  type PathHit,
} from './pathEdit';

/** Narrows a `PathHit | null` for the tests below — the pure functions are allowed to return `null`, but every test here sets up a query that must hit. */
function requireHit(hit: PathHit | null): PathHit {
  if (!hit) throw new Error('expected a hit');
  return hit;
}

/** Narrows a `VectorPath[] | null` — same role as `requireHit` for `deleteAnchor`'s "delete the whole node" signal. */
function requirePaths(paths: VectorPath[] | null): VectorPath[] {
  if (!paths) throw new Error('expected paths, got null (node deletion)');
  return paths;
}

function requirePoint(point: Point2D | undefined): Point2D {
  if (!point) throw new Error('expected a defined point');
  return point;
}

const cornerAnchor: AnchorPoint = { point: { x: 10, y: 10 } };
const smoothAnchor: AnchorPoint = {
  point: { x: 10, y: 10 },
  handleOut: { x: 20, y: 10 }, // +x direction, length 10
  handleIn: { x: 5, y: 10 }, // -x direction, length 5 (unmirrored -> smooth)
};
const symmetricAnchor: AnchorPoint = {
  point: { x: 10, y: 10 },
  handleOut: { x: 20, y: 10 },
  handleIn: { x: 0, y: 10 }, // mirrored, length 10 both sides
};
const brokenAnchor: AnchorPoint = {
  point: { x: 10, y: 10 },
  handleOut: { x: 20, y: 10 },
  handleIn: { x: 10, y: 0 }, // perpendicular, not collinear -> corner
};

describe('anchorMode', () => {
  it('no handles -> corner', () => {
    expect(anchorMode(cornerAnchor)).toBe('corner');
  });
  it('collinear, unmirrored lengths -> smooth', () => {
    expect(anchorMode(smoothAnchor)).toBe('smooth');
  });
  it('collinear, mirrored lengths -> symmetric', () => {
    expect(anchorMode(symmetricAnchor)).toBe('symmetric');
  });
  it('handles present but not collinear -> corner (broken tangent)', () => {
    expect(anchorMode(brokenAnchor)).toBe('corner');
  });
});

describe('cycleAnchorMode', () => {
  it('corner -> smooth: synthesises collinear handles from neighbour directions', () => {
    const path: VectorPath = {
      closed: false,
      anchors: [
        { point: { x: 0, y: 0 } },
        { point: { x: 10, y: 0 } }, // corner anchor to cycle
        { point: { x: 20, y: 10 } },
      ],
    };
    const next = cycleAnchorMode(path, 1);
    expect(anchorMode(next.anchors[1])).toBe('smooth');
    expect(next.anchors[1].handleIn).toBeDefined();
    expect(next.anchors[1].handleOut).toBeDefined();
  });

  it('smooth -> symmetric: equalises handle lengths, keeps direction', () => {
    const path: VectorPath = { closed: false, anchors: [smoothAnchor] };
    const next = cycleAnchorMode(path, 0);
    expect(anchorMode(next.anchors[0])).toBe('symmetric');
  });

  it('symmetric -> corner: strips both handles', () => {
    const path: VectorPath = { closed: false, anchors: [symmetricAnchor] };
    const next = cycleAnchorMode(path, 0);
    expect(next.anchors[0].handleIn).toBeUndefined();
    expect(next.anchors[0].handleOut).toBeUndefined();
    expect(anchorMode(next.anchors[0])).toBe('corner');
  });

  it('full cycle returns to corner', () => {
    let path: VectorPath = {
      closed: false,
      anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 20, y: 5 } }],
    };
    path = cycleAnchorMode(path, 1); // -> smooth
    path = cycleAnchorMode(path, 1); // -> symmetric
    path = cycleAnchorMode(path, 1); // -> corner
    expect(anchorMode(path.anchors[1])).toBe('corner');
  });
});

describe('moveAnchor', () => {
  it('translates the point and both handles rigidly', () => {
    const moved = moveAnchor(symmetricAnchor, { x: 5, y: -5 });
    expect(moved.point).toEqual({ x: 15, y: 5 });
    expect(moved.handleOut).toEqual({ x: 25, y: 5 });
    expect(moved.handleIn).toEqual({ x: 5, y: 5 });
  });

  it('leaves absent handles absent', () => {
    const moved = moveAnchor(cornerAnchor, { x: 1, y: 1 });
    expect(moved.handleIn).toBeUndefined();
    expect(moved.handleOut).toBeUndefined();
  });
});

describe('movePath', () => {
  it('translates every anchor point and handle by the same delta, closed flag untouched', () => {
    const path: VectorPath = {
      closed: true,
      anchors: [symmetricAnchor, cornerAnchor],
    };
    const moved = movePath(path, { x: 5, y: -5 });
    expect(moved.closed).toBe(true);
    expect(moved.anchors[0].point).toEqual({ x: 15, y: 5 });
    expect(moved.anchors[0].handleOut).toEqual({ x: 25, y: 5 });
    expect(moved.anchors[0].handleIn).toEqual({ x: 5, y: 5 });
    expect(moved.anchors[1].point).toEqual({ x: 15, y: 5 });
    expect(moved.anchors[1].handleIn).toBeUndefined();
    expect(moved.anchors[1].handleOut).toBeUndefined();
  });

  it('leaves relative handle geometry (shape) unchanged — only translated', () => {
    const path: VectorPath = { closed: false, anchors: [symmetricAnchor] };
    const moved = movePath(path, { x: 100, y: 100 });
    const anchor = moved.anchors[0];
    const handleOut = requirePoint(anchor.handleOut);
    const handleIn = requirePoint(anchor.handleIn);
    const outVec = { x: handleOut.x - anchor.point.x, y: handleOut.y - anchor.point.y };
    const inVec = { x: handleIn.x - anchor.point.x, y: handleIn.y - anchor.point.y };
    expect(outVec).toEqual({ x: 10, y: 0 }); // same as symmetricAnchor's own handleOut - point
    expect(inVec).toEqual({ x: -10, y: 0 });
  });

  it('zero delta is a no-op', () => {
    const path: VectorPath = { closed: true, anchors: [cornerAnchor] };
    const moved = movePath(path, { x: 0, y: 0 });
    expect(moved.anchors[0].point).toEqual(cornerAnchor.point);
  });
});

describe('dragHandle', () => {
  it('symmetric mode: mirrors the opposite handle exactly (collinear + equal length)', () => {
    const next = dragHandle(symmetricAnchor, 'out', { x: 10, y: 40 }, 'symmetric');
    // dragged handleOut = (10,40): vector from point (10,10) is (0,30), length 30.
    expect(next.handleOut).toEqual({ x: 10, y: 40 });
    expect(next.handleIn).toEqual({ x: 10, y: -20 }); // point - same vector
  });

  it('smooth mode: keeps collinearity but preserves the opposite handle length', () => {
    const next = dragHandle(smoothAnchor, 'out', { x: 10, y: 40 }, 'smooth');
    const handleIn = requirePoint(next.handleIn);
    const handleOut = requirePoint(next.handleOut);
    // opposite (handleIn) length was 5 in the original smoothAnchor.
    const oppositeLen = Math.hypot(handleIn.x - 10, handleIn.y - 10);
    expect(oppositeLen).toBeCloseTo(5, 6);
    // still collinear (opposite direction) with the new handleOut vector.
    const vOut = { x: handleOut.x - 10, y: handleOut.y - 10 };
    const vIn = { x: handleIn.x - 10, y: handleIn.y - 10 };
    const cross = vOut.x * vIn.y - vOut.y * vIn.x;
    expect(cross).toBeCloseTo(0, 6);
  });

  it('corner mode: the dragged handle moves freely, opposite untouched', () => {
    const next = dragHandle(brokenAnchor, 'out', { x: 99, y: 99 }, 'corner');
    expect(next.handleOut).toEqual({ x: 99, y: 99 });
    expect(next.handleIn).toEqual(brokenAnchor.handleIn);
  });
});

describe('closestPointOnPaths / insertAnchorAt', () => {
  it('finds the closest segment across multiple paths', () => {
    const paths: VectorPath[] = [
      { closed: false, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 100, y: 0 } }] },
      { closed: false, anchors: [{ point: { x: 0, y: 100 } }, { point: { x: 100, y: 100 } }] },
    ];
    const hit = requireHit(closestPointOnPaths(paths, { x: 50, y: 90 }));
    expect(hit.pathIndex).toBe(1);
    expect(hit.distance).toBeCloseTo(10, 1);
  });

  it('insert on a straight segment: plain corner anchor, no spurious handles, shape unchanged', () => {
    const paths: VectorPath[] = [
      { closed: false, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 100, y: 0 } }] },
    ];
    const hit = requireHit(closestPointOnPaths(paths, { x: 40, y: 0 }));
    const next = insertAnchorAt(paths, hit);
    expect(next[0].anchors).toHaveLength(3);
    const inserted = next[0].anchors[1];
    expect(inserted.point.x).toBeCloseTo(40, 1);
    expect(inserted.handleIn).toBeUndefined();
    expect(inserted.handleOut).toBeUndefined();
  });

  it('insert on a curved segment: both halves trace the original curve (shape preserved)', () => {
    const from: AnchorPoint = { point: { x: 0, y: 0 }, handleOut: { x: 30, y: 90 } };
    const to: AnchorPoint = { point: { x: 100, y: 20 }, handleIn: { x: 70, y: -40 } };
    const paths: VectorPath[] = [{ closed: false, anchors: [from, to] }];
    const originalCubic = {
      p0: from.point,
      c1: requirePoint(from.handleOut),
      c2: requirePoint(to.handleIn),
      p1: to.point,
    };

    const query = cubicPointAt(originalCubic, 0.37);
    const hit = requireHit(closestPointOnPaths(paths, query));
    expect(hit.distance).toBeLessThan(0.5);

    const next = insertAnchorAt(paths, hit);
    expect(next[0].anchors).toHaveLength(3);
    const [newFrom, mid, newTo] = next[0].anchors;

    // Sample both new segments against the original curve at scaled t.
    const leftCubic = {
      p0: newFrom.point,
      c1: requirePoint(newFrom.handleOut),
      c2: requirePoint(mid.handleIn),
      p1: mid.point,
    };
    const rightCubic = {
      p0: mid.point,
      c1: requirePoint(mid.handleOut),
      c2: requirePoint(newTo.handleIn),
      p1: newTo.point,
    };
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const leftP = cubicPointAt(leftCubic, t);
      const origLeftP = cubicPointAt(originalCubic, t * hit.t);
      expect(leftP.x).toBeCloseTo(origLeftP.x, 6);
      expect(leftP.y).toBeCloseTo(origLeftP.y, 6);

      const rightP = cubicPointAt(rightCubic, t);
      const origRightP = cubicPointAt(originalCubic, hit.t + t * (1 - hit.t));
      expect(rightP.x).toBeCloseTo(origRightP.x, 6);
      expect(rightP.y).toBeCloseTo(origRightP.y, 6);
    }
  });

  it('insert on a closed path wraps the last segment correctly', () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 100, y: 0 } },
          { point: { x: 50, y: 100 } },
        ],
      },
    ];
    // The closing segment runs from the last anchor (50,100) back to the first (0,0).
    const hit = requireHit(closestPointOnPaths(paths, { x: 25, y: 50 }));
    expect(hit.segmentIndex).toBe(2);
    const next = insertAnchorAt(paths, hit);
    expect(next[0].anchors).toHaveLength(4);
    // New anchor was appended at the end (between last and wrapped-first).
    expect(next[0].anchors[3].point.x).toBeCloseTo(hit.point.x, 6);
  });
});

describe('deleteAnchor', () => {
  it('removes an anchor from an open path with plenty left', () => {
    const paths: VectorPath[] = [
      {
        closed: false,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 10, y: 0 } },
          { point: { x: 20, y: 0 } },
        ],
      },
    ];
    const next = requirePaths(deleteAnchor(paths, 0, 1));
    expect(next[0].anchors).toHaveLength(2);
  });

  it('deletes the whole path when a closed path drops below 3 anchors', () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 10, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
      { closed: false, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 1, y: 1 } }] },
    ];
    const next = requirePaths(deleteAnchor(paths, 0, 0));
    expect(next).toHaveLength(1);
    expect(next[0].closed).toBe(false);
  });

  it('deletes the whole path when an open path drops below 2 anchors', () => {
    const paths: VectorPath[] = [
      { closed: false, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 1, y: 1 } }] },
      { closed: false, anchors: [{ point: { x: 5, y: 5 } }, { point: { x: 6, y: 6 } }] },
    ];
    const next = deleteAnchor(paths, 0, 0);
    expect(next).toHaveLength(1);
  });

  it('returns null (delete the node) when the last path is deleted', () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 10, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ];
    const next = deleteAnchor(paths, 0, 0);
    expect(next).toBeNull();
  });
});
