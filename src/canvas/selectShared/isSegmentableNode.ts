import type { SceneNode } from '@/scene/types';

/**
 * The node kinds Smart Select and Colour Select can segment: the ones that
 * cook to pixels (pixel, vector, text). One test shared by the tools'
 * activation in `Viewport.tsx` and `adoptSelectedTarget.ts`.
 */
export function isSegmentableNode(node: Pick<SceneNode, 'type'> | undefined | null): boolean {
  return node?.type === 'pixel' || node?.type === 'vector' || node?.type === 'text';
}
