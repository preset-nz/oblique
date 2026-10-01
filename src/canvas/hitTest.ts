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
import { hitTestNode, type Point, worldToLocal } from './transform2d';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Topmost visible image node whose transformed bounds contain `docPoint`
 * (document space). Array order is layer-panel order — index 0 is the top
 * of the stack (scene/types.ts) — so the first match wins, no bottom-up
 * walk needed (that's the compositor's paint concern, not hit-testing's).
 * Bounds are the node's own full-resolution (`baked`) size, matching
 * `Transform2D`'s document-space units.
 */
export function topmostNodeAt(scene: Scene, docPoint: Point): SceneNode | undefined {
  for (const node of scene.nodes) {
    if (!node.visible || node.output !== 'image') continue;
    const [w, h] = destSizeFor(node, 'baked', scene.documentSize);
    const t = node.transform2d ?? IDENTITY_TRANSFORM_2D;
    if (isVectorNode(node)) {
      // A vector node's raster spans the document, but its SHAPE doesn't —
      // hit only the tight path bounds (dogfood 2026-07-05: a full-canvas
      // hit area left no empty spot to click-deselect). worldToLocal with
      // the raster extent matches how the compositor transforms the
      // document-sized raster, so the bbox test happens in the same local
      // space the shape is painted in.
      const bounds = vectorContentBounds(node.paths);
      if (!bounds) continue;
      if (pointInRect(worldToLocal(docPoint, t, { w, h }), bounds)) return node;
      continue;
    }
    if (isTextNode(node)) {
      // Same idea as vectors: hit the glyph bounds (anchor space, so translate
      // by `position` into the document-sized raster's local space). No cached
      // geometry yet (not cooked) -> not hittable.
      const bounds = getGeometry(node)?.bounds;
      if (!bounds) continue;
      const rect = { ...bounds, x: bounds.x + node.position.x, y: bounds.y + node.position.y };
      if (pointInRect(worldToLocal(docPoint, t, { w, h }), rect)) return node;
      continue;
    }
    if (hitTestNode(docPoint, t, { w, h })) return node;
  }
  return undefined;
}
