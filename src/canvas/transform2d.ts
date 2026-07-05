import { IDENTITY_TRANSFORM_2D, type Transform2D } from '@/scene/types';
import {
  boxCornersFor,
  CORNER_SIGN,
  handlePositionsFor,
  type HandleId as ScaleHandleId,
} from './boxHandles';

/**
 * Pure geometry for the node-transform-2d story (features/05-selection/
 * node-transform-2d.md): the TransformBox overlay's handle layout, drag ->
 * transform maths, and canvas hit-testing. All document-space (BAKED/full
 * resolution), matching `Transform2D`'s own units — no level factor here;
 * that scaling is the compositor's paint-time concern only
 * (`compositor/composite.ts::withNodeTransform`).
 *
 * Forward model (must mirror the compositor exactly, or the overlay drifts
 * from the pixels): a local point `L` in the node's own untransformed
 * `[0, w] x [0, h]` space maps to a document point via
 *   world = centre + R(rotation) . S(scaleX, scaleY) . (L - localCentre)
 * where `centre = (x + w/2, y + h/2)` and `localCentre = (w/2, h/2)`.
 *
 * The 8-handle layout itself (corner signs, cursor styles, handle
 * enumeration) lives in `boxHandles.ts`, shared with the marquee overlays
 * (`marquees/marqueeGeometry.ts`) — this module supplies only the
 * rotation+scale `localToWorld` mapping those handles are placed through.
 */

export type { Transform2D };
export { IDENTITY_TRANSFORM_2D };

export interface Point {
  x: number;
  y: number;
}

export interface NodeExtent {
  w: number;
  h: number;
}

function centreOf(t: Transform2D, extent: NodeExtent): Point {
  return { x: t.x + extent.w / 2, y: t.y + extent.h / 2 };
}

/** Local (untransformed, `[0,w]x[0,h]`) point -> document-space point. */
export function localToWorld(local: Point, t: Transform2D, extent: NodeExtent): Point {
  const centre = centreOf(t, extent);
  const lx = (local.x - extent.w / 2) * t.scaleX;
  const ly = (local.y - extent.h / 2) * t.scaleY;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return {
    x: centre.x + lx * cos - ly * sin,
    y: centre.y + lx * sin + ly * cos,
  };
}

/** Document-space point -> local (untransformed) point — the inverse of `localToWorld`. */
export function worldToLocal(world: Point, t: Transform2D, extent: NodeExtent): Point {
  const centre = centreOf(t, extent);
  const dx = world.x - centre.x;
  const dy = world.y - centre.y;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  const sx = t.scaleX === 0 ? 0 : rx / t.scaleX;
  const sy = t.scaleY === 0 ? 0 : ry / t.scaleY;
  return { x: sx + extent.w / 2, y: sy + extent.h / 2 };
}

/** True if `world` falls within the node's transformed bounds. */
export function hitTestNode(world: Point, t: Transform2D, extent: NodeExtent): boolean {
  const local = worldToLocal(world, t, extent);
  return local.x >= 0 && local.x <= extent.w && local.y >= 0 && local.y <= extent.h;
}

export type HandleId = ScaleHandleId | 'rotate';

/** Document-space distance the rotate handle sits above the node's top-centre, at 1x view scale. */
export const ROTATE_HANDLE_OFFSET = 32;

/** World-space position of every handle for the current transform, for the overlay to render. */
export function handlePositions(t: Transform2D, extent: NodeExtent): Record<HandleId, Point> {
  const toWorld = (local: Point) => localToWorld(local, t, extent);
  const positions = handlePositionsFor(toWorld, extent) as Record<HandleId, Point>;
  const rotateLocal = { x: extent.w / 2, y: -ROTATE_HANDLE_OFFSET };
  positions.rotate = toWorld(rotateLocal);
  return positions;
}

/** The four outer corners of the transformed node, for drawing the box outline. */
export function boundsCorners(t: Transform2D, extent: NodeExtent): Point[] {
  const toWorld = (local: Point) => localToWorld(local, t, extent);
  return boxCornersFor(toWorld, extent);
}

/** Move drag: `start` is the transform at pointer-down, `deltaWorld` the doc-space pointer delta since. */
export function applyMove(start: Transform2D, deltaWorld: Point): Transform2D {
  return { ...start, x: start.x + deltaWorld.x, y: start.y + deltaWorld.y };
}

function snapAngle(radians: number, stepDegrees: number): number {
  const step = (stepDegrees * Math.PI) / 180;
  return Math.round(radians / step) * step;
}

/**
 * Rotate drag: angle from the node's centre to the current pointer, minus the
 * angle at drag-start, added to the transform's rotation at drag-start.
 * `snap` (Shift held) rounds the result to the nearest 15 degrees.
 */
export function applyRotate(
  start: Transform2D,
  extent: NodeExtent,
  pointerWorld: Point,
  startPointerWorld: Point,
  snap: boolean,
): Transform2D {
  const centre = centreOf(start, extent);
  const startAngle = Math.atan2(startPointerWorld.y - centre.y, startPointerWorld.x - centre.x);
  const currentAngle = Math.atan2(pointerWorld.y - centre.y, pointerWorld.x - centre.x);
  let rotation = start.rotation + (currentAngle - startAngle);
  if (snap) rotation = snapAngle(rotation, 15);
  return { ...start, rotation };
}

const MIN_SCALE_MAGNITUDE = 0.02;

/** `world - centre`, rotated back by `-rotation` — scale-independent (unlike `worldToLocal`, which also divides by the *current* scale). */
function unrotatedOffset(world: Point, t: Transform2D, extent: NodeExtent): Point {
  const centre = centreOf(t, extent);
  const dx = world.x - centre.x;
  const dy = world.y - centre.y;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function clampMagnitude(scale: number): number {
  if (Math.abs(scale) < MIN_SCALE_MAGNITUDE) {
    return scale < 0 ? -MIN_SCALE_MAGNITUDE : MIN_SCALE_MAGNITUDE;
  }
  return scale;
}

/**
 * Scale drag: a handle drag scales around the node's own centre (matching
 * this story's single compositor code path — rotation and scale share one
 * centre, node-transform-2d.md). A handle's own local anchor corner stays
 * put relative to the node's local frame; solving `unrotatedOffset = newScale
 * * halfExtent * sign` for `newScale` gives the factor that puts that corner
 * exactly under the pointer, so dragging a corner out to 2x the half-width
 * doubles `scaleX`. Edge handles (n/s/e/w) only move their own axis — the
 * other keeps `start`'s value. `snap` (Shift held) locks both axes to the
 * larger of the two magnitudes (uniform scale), preserving each axis's sign.
 */
export function applyScale(
  start: Transform2D,
  extent: NodeExtent,
  handle: Exclude<HandleId, 'rotate'>,
  pointerWorld: Point,
  snap: boolean,
): Transform2D {
  const [sx, sy] = CORNER_SIGN[handle];
  const offset = unrotatedOffset(pointerWorld, start, extent);
  const halfW = extent.w / 2;
  const halfH = extent.h / 2;

  let nextScaleX = start.scaleX;
  let nextScaleY = start.scaleY;
  if (sx !== 0 && halfW > 0) {
    nextScaleX = clampMagnitude(offset.x / (halfW * sx));
  }
  if (sy !== 0 && halfH > 0) {
    nextScaleY = clampMagnitude(offset.y / (halfH * sy));
  }

  if (snap) {
    const magnitude = Math.max(Math.abs(nextScaleX), Math.abs(nextScaleY));
    if (sx !== 0) nextScaleX = Math.sign(nextScaleX) * magnitude;
    if (sy !== 0) nextScaleY = Math.sign(nextScaleY) * magnitude;
  }

  return { ...start, scaleX: nextScaleX, scaleY: nextScaleY };
}
