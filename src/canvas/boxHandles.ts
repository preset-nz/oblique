/**
 * Shared 8-handle box geometry — the module `transform2d.ts` (TransformBox)
 * and `marquees/marqueeGeometry.ts` (Rect/Ellipse marquees) both consume, so
 * the handle layout/cursor/corner-sign math exists exactly once (epic 05
 * acceptance: "TransformBox and marquee overlay share one SVG geometry/
 * handle module — no duplicated 8-handle math").
 *
 * Deliberately *not* shared: the drag-to-transform algebra. TransformBox
 * scales/rotates a node around its own local frame (`transform2d.ts`'s
 * `applyScale`/`applyRotate`); a marquee has no rotation and resizes by
 * moving one edge/corner while its opposite stays put
 * (`marqueeGeometry.ts`'s `resizeRect`). Same interaction vocabulary
 * (8 handles, Shift = constrain), different semantics — the story's own
 * framing ("One story, not three") for why these two call sites diverge
 * past this shared layer.
 *
 * Callers supply their own local-space -> world-space mapping (`toWorld`):
 * TransformBox's is rotation + scale around the node's centre; a marquee's
 * is a plain offset by the rect's top-left corner (axis-aligned, no
 * rotation). Handle enumeration, corner signs and cursor styles are
 * identical either way.
 */

export interface Point {
  x: number;
  y: number;
}

export interface BoxExtent {
  w: number;
  h: number;
}

/** The 8 resize handles around a box (no rotation handle — that's TransformBox-only, added on top of this set). */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const SCALE_HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Local-space sign of each handle relative to the box's centre: -1/0/+1 per axis. */
export const CORNER_SIGN: Record<HandleId, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export const CURSOR_FOR_HANDLE: Record<HandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

/** Local-space anchor point (within `[0,w]x[0,h]`) for a given handle. */
export function handleLocalAnchor(handle: HandleId, extent: BoxExtent): Point {
  const [sx, sy] = CORNER_SIGN[handle];
  return { x: (extent.w / 2) * (1 + sx), y: (extent.h / 2) * (1 + sy) };
}

/**
 * World-space position of every scale handle, given the caller's own
 * local -> world mapping (rotation/scale for TransformBox, a plain offset
 * for an axis-aligned marquee).
 */
export function handlePositionsFor(
  toWorld: (local: Point) => Point,
  extent: BoxExtent,
): Record<HandleId, Point> {
  const positions = {} as Record<HandleId, Point>;
  for (const id of SCALE_HANDLES) {
    positions[id] = toWorld(handleLocalAnchor(id, extent));
  }
  return positions;
}

/** The four outer corners of the box (nw, ne, se, sw in path order), for drawing an outline. */
export function boxCornersFor(toWorld: (local: Point) => Point, extent: BoxExtent): Point[] {
  return [
    toWorld({ x: 0, y: 0 }),
    toWorld({ x: extent.w, y: 0 }),
    toWorld({ x: extent.w, y: extent.h }),
    toWorld({ x: 0, y: extent.h }),
  ];
}
