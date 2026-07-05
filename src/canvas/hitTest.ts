import { destSizeFor } from '@/compositor/composite';
import { IDENTITY_TRANSFORM_2D, isVectorNode, type Scene, type SceneNode } from '@/scene/types';
import { vectorContentBounds } from '@/scene/vectorBounds';
import { hitTestNode, type Point, worldToLocal } from './transform2d';

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
      const local = worldToLocal(docPoint, t, { w, h });
      if (
        local.x >= bounds.x &&
        local.x <= bounds.x + bounds.w &&
        local.y >= bounds.y &&
        local.y <= bounds.y + bounds.h
      ) {
        return node;
      }
      continue;
    }
    if (hitTestNode(docPoint, t, { w, h })) return node;
  }
  return undefined;
}
