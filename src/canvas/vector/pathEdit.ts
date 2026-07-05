import type { AnchorPoint, Point2D, VectorPath } from '@/scene/types';
import { type Cubic, closestPointOnCubic, splitCubicAt } from './bezier';

/**
 * Pure geometry/surgery for direct-selection path editing
 * (features/06-vector-nodes/path-editing.md). No store, no DOM, no React —
 * `PathEditor.tsx` is a thin pointer-event shell around these functions, the
 * same split `bezier.ts` and `marqueeGeometry.ts` already use so the hard
 * maths is unit-testable without mounting a component.
 *
 * `AnchorMode` is never stored — it's always derived from the anchor's own
 * geometry (`anchorMode`), per the story: "derive current mode from geometry:
 * no handles = corner; collinear mirrored = symmetric; collinear unmirrored
 * = smooth". Anything else (both handles present but not collinear — the
 * "broken tangent" the story's "corner frees both" leaves room for) also
 * reads as `corner`, since corner is the only mode without a collinearity
 * invariant to maintain.
 */

export type AnchorMode = 'corner' | 'smooth' | 'symmetric';

const EPSILON = 1e-6;
/** Collinearity tolerance: |sin(angle between handles)| below this counts as "on the same line". */
const COLLINEAR_SIN_TOLERANCE = 1e-3;
/** Relative length tolerance for "mirrored" (symmetric) handles. */
const MIRROR_LENGTH_TOLERANCE = 1e-2;

function vec(from: Point2D, to: Point2D): Point2D {
  return { x: to.x - from.x, y: to.y - from.y };
}

function length(v: Point2D): number {
  return Math.hypot(v.x, v.y);
}

function translate(p: Point2D, delta: Point2D): Point2D {
  return { x: p.x + delta.x, y: p.y + delta.y };
}

/** Derives the anchor's editing mode from its current geometry — see module doc. */
export function anchorMode(anchor: AnchorPoint): AnchorMode {
  if (!anchor.handleIn || !anchor.handleOut) return 'corner';
  const vOut = vec(anchor.point, anchor.handleOut);
  const vIn = vec(anchor.point, anchor.handleIn);
  const lenOut = length(vOut);
  const lenIn = length(vIn);
  if (lenOut < EPSILON || lenIn < EPSILON) return 'corner';

  const cross = (vOut.x * vIn.y - vOut.y * vIn.x) / (lenOut * lenIn);
  const dot = (vOut.x * vIn.x + vOut.y * vIn.y) / (lenOut * lenIn);
  // Collinear AND pointing to opposite sides of the anchor (a real tangent
  // line through the point) — a handle folded back onto the same side as its
  // opposite is not a sensible smooth/symmetric anchor.
  const collinearOpposite = Math.abs(cross) < COLLINEAR_SIN_TOLERANCE && dot < 0;
  if (!collinearOpposite) return 'corner';

  const mirrored = Math.abs(lenOut - lenIn) < MIRROR_LENGTH_TOLERANCE * Math.max(lenOut, lenIn, 1);
  return mirrored ? 'symmetric' : 'smooth';
}

/** Anchor index of the segment starting at `i`'s far end, honouring `closed` wraparound. */
function nextIndex(path: VectorPath, i: number): number {
  const n = path.anchors.length;
  return path.closed ? (i + 1) % n : i + 1;
}

function prevIndex(path: VectorPath, i: number): number {
  const n = path.anchors.length;
  return path.closed ? (i - 1 + n) % n : i - 1;
}

/**
 * Synthesises collinear handles for an anchor that currently has none (going
 * corner -> smooth), derived from the direction between its neighbours —
 * "sensible handles from neighbouring segment directions" per the story.
 * Length is 1/3 of each side's own neighbour-segment length (the classic
 * "thirds" rule of thumb for a first-guess smooth handle), independent
 * per side, so the result is `smooth` (collinear, generally unmirrored) —
 * never accidentally `symmetric` — matching the corner -> smooth -> symmetric
 * cycle order. A fully isolated anchor (no neighbours at all — a single-point
 * open "path") has nothing to derive a direction from and is returned
 * unchanged.
 */
function synthesizeSmoothHandles(path: VectorPath, i: number): AnchorPoint {
  const anchor = path.anchors[i];
  const n = path.anchors.length;
  const hasPrev = path.closed ? n > 1 : i > 0;
  const hasNext = path.closed ? n > 1 : i < n - 1;
  const prevPt = hasPrev ? path.anchors[prevIndex(path, i)].point : null;
  const nextPt = hasNext ? path.anchors[nextIndex(path, i)].point : null;

  let dir: Point2D;
  if (prevPt && nextPt) {
    dir = vec(prevPt, nextPt);
  } else if (nextPt) {
    dir = vec(anchor.point, nextPt);
  } else if (prevPt) {
    dir = vec(prevPt, anchor.point);
  } else {
    return anchor;
  }
  const dirLen = length(dir);
  if (dirLen < EPSILON) return anchor;
  const unit = { x: dir.x / dirLen, y: dir.y / dirLen };

  const segLenOut = nextPt ? length(vec(anchor.point, nextPt)) : 0;
  const segLenIn = prevPt ? length(vec(prevPt, anchor.point)) : 0;
  // A missing side (open-path endpoint) borrows the other side's length so
  // the synthesised handle isn't zero-length.
  const outLen = (segLenOut || segLenIn) / 3;
  const inLen = (segLenIn || segLenOut) / 3;

  return {
    point: anchor.point,
    handleOut: { x: anchor.point.x + unit.x * outLen, y: anchor.point.y + unit.y * outLen },
    handleIn: { x: anchor.point.x - unit.x * inLen, y: anchor.point.y - unit.y * inLen },
  };
}

/** Equalises both handle lengths (keeping their shared direction) — smooth -> symmetric. */
function makeSymmetric(anchor: AnchorPoint): AnchorPoint {
  if (!anchor.handleOut || !anchor.handleIn) return anchor;
  const vOut = vec(anchor.point, anchor.handleOut);
  const vIn = vec(anchor.point, anchor.handleIn);
  const lenOut = length(vOut);
  const lenIn = length(vIn);
  const avg = (lenOut + lenIn) / 2 || 1;
  const unit = lenOut > EPSILON ? { x: vOut.x / lenOut, y: vOut.y / lenOut } : { x: 0, y: 0 };
  return {
    point: anchor.point,
    handleOut: { x: anchor.point.x + unit.x * avg, y: anchor.point.y + unit.y * avg },
    handleIn: { x: anchor.point.x - unit.x * avg, y: anchor.point.y - unit.y * avg },
  };
}

/**
 * Advances one anchor's mode: corner -> smooth -> symmetric -> corner
 * (symmetric -> corner strips both handles, the "no handles = corner"
 * ground state). Returns a new `VectorPath` (only the target path); callers
 * splice it back into the node's `paths` array.
 */
export function cycleAnchorMode(path: VectorPath, anchorIndex: number): VectorPath {
  const anchor = path.anchors[anchorIndex];
  const mode = anchorMode(anchor);
  const next: AnchorPoint =
    mode === 'corner'
      ? synthesizeSmoothHandles(path, anchorIndex)
      : mode === 'smooth'
        ? makeSymmetric(anchor)
        : { point: anchor.point };
  const anchors = path.anchors.slice();
  anchors[anchorIndex] = next;
  return { ...path, anchors };
}

/** Moves an anchor's point and both handles rigidly by `delta` (drag-the-anchor). */
export function moveAnchor(anchor: AnchorPoint, delta: Point2D): AnchorPoint {
  return {
    point: translate(anchor.point, delta),
    handleIn: anchor.handleIn ? translate(anchor.handleIn, delta) : undefined,
    handleOut: anchor.handleOut ? translate(anchor.handleOut, delta) : undefined,
  };
}

/**
 * Drags one handle to `newPos`, applying `mode`'s constraint (captured once
 * at drag start by the caller, from the anchor's pre-drag geometry — a
 * derived mode must not be re-evaluated mid-drag, or geometry passing
 * through a degenerate state could flip behaviour under the pointer):
 *
 * - `corner`: the dragged handle moves freely, the opposite handle untouched.
 * - `smooth`: the opposite handle is kept collinear through the anchor point
 *   (mirrored direction) but keeps its own length independent of the dragged
 *   handle's new length.
 * - `symmetric`: the opposite handle mirrors the dragged handle exactly
 *   (collinear AND equal length).
 */
export function dragHandle(
  anchor: AnchorPoint,
  side: 'in' | 'out',
  newPos: Point2D,
  mode: AnchorMode,
): AnchorPoint {
  if (mode === 'corner') {
    return side === 'in' ? { ...anchor, handleIn: newPos } : { ...anchor, handleOut: newPos };
  }

  const opposite = side === 'in' ? anchor.handleOut : anchor.handleIn;
  const vNew = vec(anchor.point, newPos);
  const lenNew = length(vNew);
  if (lenNew < EPSILON) {
    return side === 'in' ? { ...anchor, handleIn: newPos } : { ...anchor, handleOut: newPos };
  }
  const unit = { x: vNew.x / lenNew, y: vNew.y / lenNew };
  const oppositeLen =
    mode === 'symmetric' ? lenNew : opposite ? length(vec(anchor.point, opposite)) : lenNew;
  const oppositePos = {
    x: anchor.point.x - unit.x * oppositeLen,
    y: anchor.point.y - unit.y * oppositeLen,
  };

  return {
    point: anchor.point,
    handleIn: side === 'in' ? newPos : oppositePos,
    handleOut: side === 'out' ? newPos : oppositePos,
  };
}

// --- Insert anchor (closest-point-on-segment + de Casteljau split) --------

/** The rendering-equivalent cubic for the segment `i -> nextIndex(path, i)` — same c1/c2 derivation as `vectorRasterize.ts::segmentCommand`, so hit-testing never drifts from what's actually drawn. */
function segmentCubic(path: VectorPath, i: number): Cubic {
  const from = path.anchors[i];
  const to = path.anchors[nextIndex(path, i)];
  return {
    p0: from.point,
    c1: from.handleOut ?? from.point,
    c2: to.handleIn ?? to.point,
    p1: to.point,
  };
}

export interface PathHit {
  pathIndex: number;
  /** Anchor index the hit segment starts at; the segment runs to `nextIndex`. */
  segmentIndex: number;
  t: number;
  point: Point2D;
  distance: number;
}

/** Closest point across every segment of every path — the anchor-insertion hit test. `null` when no path has a segment (e.g. every path is a single lone anchor). */
export function closestPointOnPaths(paths: VectorPath[], query: Point2D): PathHit | null {
  let best: PathHit | null = null;
  paths.forEach((path, pathIndex) => {
    const segCount = path.closed ? path.anchors.length : path.anchors.length - 1;
    for (let i = 0; i < segCount; i++) {
      const result = closestPointOnCubic(segmentCubic(path, i), query);
      if (!best || result.distance < best.distance) {
        best = {
          pathIndex,
          segmentIndex: i,
          t: result.t,
          point: result.point,
          distance: result.distance,
        };
      }
    }
  });
  return best;
}

/**
 * Inserts a new anchor at `hit` (from `closestPointOnPaths`), splitting the
 * hit segment via de Casteljau so both resulting segments trace exactly the
 * curve the single original segment did — "shape visually unchanged at
 * insert time" (acceptance). A segment with no curvature on either side
 * (both `from.handleOut` and `to.handleIn` absent — rendered as a plain
 * `lineTo`) gets a plain corner anchor with no surgery on its neighbours,
 * keeping straight segments straight rather than introducing degenerate
 * curve handles that happen to sit on the line.
 */
export function insertAnchorAt(paths: VectorPath[], hit: PathHit): VectorPath[] {
  return paths.map((path, pi) => {
    if (pi !== hit.pathIndex) return path;
    const i = hit.segmentIndex;
    const j = nextIndex(path, i);
    const from = path.anchors[i];
    const to = path.anchors[j];
    const anchors = path.anchors.slice();
    const wraps = path.closed && j === 0;
    const insertPos = wraps ? anchors.length : i + 1;

    if (!from.handleOut && !to.handleIn) {
      anchors.splice(insertPos, 0, { point: hit.point });
      return { ...path, anchors };
    }

    const { left, right } = splitCubicAt(segmentCubic(path, i), hit.t);
    const newAnchor: AnchorPoint = { point: hit.point, handleIn: left.c2, handleOut: right.c1 };
    anchors[i] = from.handleOut ? { ...from, handleOut: left.c1 } : from;
    anchors[j] = to.handleIn ? { ...to, handleIn: right.c2 } : to;
    anchors.splice(insertPos, 0, newAnchor);
    return { ...path, anchors };
  });
}

// --- Delete anchor ---------------------------------------------------------

/**
 * Removes one anchor. A closed path left with fewer than 3 anchors, or an
 * open path left with fewer than 2, can no longer describe a shape and is
 * dropped entirely (story: "closed path below 3 anchors -> delete the whole
 * path"; the open-path floor of 2 is this story's own extension of that
 * rule, undocumented in the source doc — flagged in the story report).
 * Returns `null` when the deleted path was the node's last one — the
 * caller's cue to delete the whole node (a vector node with zero paths has
 * nothing left to rasterise or edit).
 */
export function deleteAnchor(
  paths: VectorPath[],
  pathIndex: number,
  anchorIndex: number,
): VectorPath[] | null {
  const path = paths[pathIndex];
  if (!path) return paths;
  const anchors = path.anchors.filter((_, i) => i !== anchorIndex);
  const tooFew = path.closed ? anchors.length < 3 : anchors.length < 2;
  const newPaths = tooFew
    ? paths.filter((_, i) => i !== pathIndex)
    : paths.map((p, i) => (i === pathIndex ? { ...p, anchors } : p));
  return newPaths.length === 0 ? null : newPaths;
}
