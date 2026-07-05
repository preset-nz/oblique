import { boxCornersFor, CORNER_SIGN, type HandleId, handlePositionsFor } from '../boxHandles';

/**
 * Pure geometry for Rect/Ellipse/Lasso marquees (features/05-selection/
 * marquees.md). Document-space throughout (same units as `viewTransform.ts`
 * document<->screen maths and `transform2d.ts`'s node extent) — survives
 * pan/zoom because nothing here reads `ViewTransform` at all.
 *
 * Rect and Ellipse share one bounding-box representation (`Rect`): an
 * ellipse marquee is drawn as an `<ellipse>` inscribed in the same box a
 * rect marquee would draw as a `<polygon>` — identical drag/resize/move
 * geometry, only the render shape differs (`RectMarquee.tsx` /
 * `EllipseMarquee.tsx`).
 *
 * Handle layout (positions, cursors, corner signs) comes from `boxHandles.ts`,
 * shared with `transform2d.ts`'s TransformBox — no duplicated 8-handle math
 * (epic 05 acceptance). What's deliberately *not* shared is the resize
 * algebra: a marquee has no rotation, and a handle drag here keeps the
 * opposite edge/corner fixed rather than TransformBox's scale-around-centre
 * (`resizeRect` below vs. `transform2d.ts`'s `applyScale`) — same vocabulary
 * (8 handles, Shift = constrain), different semantics, per the story's
 * "One story, not three" framing.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rect with non-negative width/height, from two arbitrary corner points. */
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

/**
 * Initial drag-to-draw a rect/ellipse marquee. `anchor` is the pointer-down
 * point, `current` the live pointer position.
 *
 * - `square` (Shift held): constrains to equal width/height (a square for
 *   Rect, a circle for Ellipse — same box, `EllipseMarquee` just inscribes
 *   it).
 * - `fromCentre` (Alt held): `anchor` is the box's centre rather than a
 *   corner — the box grows symmetrically in both directions from the
 *   pointer-down point.
 */
export function rectFromDrag(
  anchor: Point,
  current: Point,
  opts: { square: boolean; fromCentre: boolean },
): Rect {
  if (opts.fromCentre) {
    let dx = current.x - anchor.x;
    let dy = current.y - anchor.y;
    if (opts.square) {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
    return normalizeRect(anchor.x - dx, anchor.y - dy, anchor.x + dx, anchor.y + dy);
  }
  let x1 = current.x;
  let y1 = current.y;
  if (opts.square) {
    const dx = current.x - anchor.x;
    const dy = current.y - anchor.y;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    x1 = anchor.x + Math.sign(dx || 1) * m;
    y1 = anchor.y + Math.sign(dy || 1) * m;
  }
  return normalizeRect(anchor.x, anchor.y, x1, y1);
}

/** Translate a drawn rect by a document-space delta (drag-to-move). */
export function moveRect(rect: Rect, delta: Point): Rect {
  return { x: rect.x + delta.x, y: rect.y + delta.y, w: rect.w, h: rect.h };
}

/**
 * Resize an already-drawn rect by dragging one of its 8 handles; the
 * opposite edge/corner from the dragged handle stays fixed. `square` (Shift
 * held) constrains the result to equal width/height, anchored at the fixed
 * corner — mirrors `transform2d.ts`'s `applyScale` snap behaviour (only the
 * axis actually being dragged is forced to the shared magnitude).
 */
export function resizeRect(rect: Rect, handle: HandleId, pointer: Point, square: boolean): Rect {
  const [sx, sy] = CORNER_SIGN[handle];

  const anchorX = sx >= 0 ? rect.x : rect.x + rect.w;
  const anchorY = sy >= 0 ? rect.y : rect.y + rect.h;

  let farX = sx === 0 ? rect.x + rect.w : pointer.x;
  let farY = sy === 0 ? rect.y + rect.h : pointer.y;

  if (square) {
    const w = Math.abs(farX - anchorX);
    const h = Math.abs(farY - anchorY);
    const m = Math.max(w, h);
    if (sx !== 0) farX = anchorX + Math.sign(farX - anchorX || 1) * m;
    if (sy !== 0) farY = anchorY + Math.sign(farY - anchorY || 1) * m;
  }

  return normalizeRect(anchorX, anchorY, farX, farY);
}

/** World-space handle positions for a rect marquee's box (no rotation — a plain corner offset). */
export function rectHandlePositions(rect: Rect): Record<HandleId, Point> {
  const toWorld = (local: Point) => ({ x: rect.x + local.x, y: rect.y + local.y });
  return handlePositionsFor(toWorld, { w: rect.w, h: rect.h });
}

/** The four outer corners of a rect marquee's box, for drawing the outline. */
export function rectCorners(rect: Rect): Point[] {
  const toWorld = (local: Point) => ({ x: rect.x + local.x, y: rect.y + local.y });
  return boxCornersFor(toWorld, { w: rect.w, h: rect.h });
}

/** True if `point` falls within `rect` — used to tell a click-to-move from a click-to-deselect. */
export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

/** Document-space minimum width/height for a rect/ellipse marquee to count as "drawn" rather than a stray click. */
export const MIN_DRAWN_RECT_SIZE = 1;

/**
 * False for a rect/ellipse marquee whose drag never moved (or barely moved)
 * off its anchor point — a plain click with a marquee tool active
 * shouldn't leave a zero-size box with 8 stacked handles and a floating
 * toolbar behind (epic acceptance: "no orphaned overlay state"). The
 * caller (`Viewport.tsx`'s pointerup) clears the marquee instead of
 * committing it when this is false.
 */
export function isDrawnRect(rect: Rect): boolean {
  return rect.w >= MIN_DRAWN_RECT_SIZE && rect.h >= MIN_DRAWN_RECT_SIZE;
}

// --- Lasso ---------------------------------------------------------------

/** Below this many points, a lasso path can't meaningfully close — a stray click shouldn't leave a 1-point "closed" shape and its toolbar behind (same "no orphaned overlay state" rule as `isDrawnRect`). */
export const MIN_LASSO_POINTS_TO_CLOSE = 3;

/** True once a lasso path has enough points to count as a real drawn shape. */
export function isDrawnLasso(points: Point[]): boolean {
  return points.length >= MIN_LASSO_POINTS_TO_CLOSE;
}

/** Append a live-drag point to a lasso path, in document space. */
export function appendLassoPoint(points: Point[], point: Point): Point[] {
  return [...points, point];
}

/**
 * True if `point` is within `thresholdDoc` (a document-space distance — the
 * caller converts a constant screen-space threshold via `viewScale` so the
 * "snap closed" feel stays constant at any zoom) of `start`. Used to close
 * the lasso on return-to-start, independent of release.
 */
export function isNearStart(point: Point, start: Point, thresholdDoc: number): boolean {
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  return dx * dx + dy * dy <= thresholdDoc * thresholdDoc;
}

/** Translate every point of a closed lasso path by a document-space delta (drag-to-move). */
export function translatePoints(points: Point[], delta: Point): Point[] {
  return points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
}

/** Bounding box of a lasso path — used for the move-drag hit test (no per-edge point-in-polygon needed for v1). */
export function lassoBounds(points: Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
