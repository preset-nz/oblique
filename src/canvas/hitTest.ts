import { destSizeFor } from '@/compositor/composite';
import { IDENTITY_TRANSFORM_2D, type Scene, type SceneNode } from '@/scene/types';
import { hitTestNode, type Point } from './transform2d';

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
    if (hitTestNode(docPoint, t, { w, h })) return node;
  }
  return undefined;
}
