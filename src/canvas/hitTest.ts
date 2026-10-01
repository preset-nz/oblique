import { destSizeFor } from '@/compositor/composite';
import { getGeometry } from '@/scene/textGeometryCache';
import {
  IDENTITY_TRANSFORM_2D,
  isTextNode,
  isVectorNode,
  type Scene,
  type SceneNode,
} from '@/scene/types';
import { vectorContentBounds } from '@/scene/vectorBounds';
import type { SnapTargets } from './snap';
import { localToWorld, type Point, worldToLocal } from './transform2d';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * A node's tight footprint: `rect` in the node's own raster-local space, plus
 * the raster `extent` that local space is transformed about (`transform2d`
 * pivots on the raster's centre). Shared by hit-testing and snapping so both
 * agree on what "the node's bounds" means.
 *
 * - pixel: the whole `sourceSize` raster;
 * - vector: the raster spans the document but the SHAPE doesn't — the tight
 *   path bounds only (dogfood 2026-07-05: a full-canvas hit area left no empty
 *   spot to click-deselect);
 * - text: the cached glyph bounds (anchor space, so translated by `position`
 *   into the document-sized raster's local space). No cached geometry yet (not
 *   cooked) -> null.
 */
function nodeFootprint(
  scene: Scene,
  node: SceneNode,
): { rect: Rect; extent: { w: number; h: number } } | null {
  const [w, h] = destSizeFor(node, 'baked', scene.documentSize);
  const extent = { w, h };
  if (isVectorNode(node)) {
    const bounds = vectorContentBounds(node.paths);
    return bounds ? { rect: bounds, extent } : null;
  }
  if (isTextNode(node)) {
    const bounds = getGeometry(node)?.bounds;
    if (!bounds) return null;
    return {
      rect: { ...bounds, x: bounds.x + node.position.x, y: bounds.y + node.position.y },
      extent,
    };
  }
  return { rect: { x: 0, y: 0, w, h }, extent };
}

/**
 * Document-space axis-aligned bounds of the node's transformed tight
 * footprint (the four footprint corners through `transform2d`), or null when
 * the node has no footprint yet. Visibility/output are the caller's concern.
 */
export function nodeWorldBounds(scene: Scene, node: SceneNode): Rect | null {
  const fp = nodeFootprint(scene, node);
  if (!fp) return null;
  const t = node.transform2d ?? IDENTITY_TRANSFORM_2D;
  const { x, y, w, h } = fp.rect;
  const corners = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ].map((c) => localToWorld(c, t, fp.extent));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * Snap targets for dragging `excludeId` (snapping.md): the document's
 * left/centre/right and top/middle/bottom, plus the same three lines per axis
 * from every other visible `output: 'image'` node's world bounds. Hidden nodes
 * (Selection nodes included) and mask nodes are not targets.
 */
export function snapTargets(scene: Scene, excludeId: string): SnapTargets {
  const [dw, dh] = scene.documentSize;
  const xs = [0, dw / 2, dw];
  const ys = [0, dh / 2, dh];
  for (const node of scene.nodes) {
    if (node.id === excludeId || !node.visible || node.output !== 'image') continue;
    const b = nodeWorldBounds(scene, node);
    if (!b) continue;
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

/**
 * Topmost visible image node whose transformed bounds contain `docPoint`
 * (document space). Array order is layer-panel order — index 0 is the top
 * of the stack (scene/types.ts) — so the first match wins, no bottom-up
 * walk needed (that's the compositor's paint concern, not hit-testing's).
 * Bounds are the node's own full-resolution (`baked`) size, matching
 * `Transform2D`'s document-space units. The bbox test happens in the same
 * local space the shape is painted in (`worldToLocal` with the raster extent
 * matches how the compositor transforms the document-sized raster).
 */
export function topmostNodeAt(scene: Scene, docPoint: Point): SceneNode | undefined {
  for (const node of scene.nodes) {
    if (!node.visible || node.output !== 'image') continue;
    const fp = nodeFootprint(scene, node);
    if (!fp) continue;
    const t = node.transform2d ?? IDENTITY_TRANSFORM_2D;
    if (pointInRect(worldToLocal(docPoint, t, fp.extent), fp.rect)) return node;
  }
  return undefined;
}
