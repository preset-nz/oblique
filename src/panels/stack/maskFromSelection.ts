import { useActiveSelectionStore } from '@/scene/activeSelection';
import { isMaskableMarquee, useMarqueeStateStore } from '@/scene/marquee';
import { useSceneStore } from '@/scene/store';
import { IDENTITY_TRANSFORM_2D } from '@/scene/types';

/**
 * "Mask from selection" on a modifier row (marquees-as-vectors.md, selections-panel.md): what
 * the button can mask with, and doing it.
 *
 * - A live marquee wins: `applyMarqueeAsVectorMask` makes a new selection node from it and
 *   binds that, and the marquee is consumed. A marquee that isn't finished yet leaves the
 *   button off rather than falling through to the active selection, which is hidden while any
 *   marquee exists.
 * - Otherwise the active selection's node is bound directly: no new node, nothing consumed, and
 *   the previous mask's source is never deleted (`mask.from_marquee`'s replace rule belongs to
 *   the marquee route only).
 *
 * Both routes give the same mask: node-pinned, with the marquee-params store's feather, expand
 * and invert and the consumer's current transform.
 */

/** True when there is something to mask with: a finished marquee, or (with no marquee) an active selection. */
export function canMaskFromSelection(
  marquee: ReturnType<typeof useMarqueeStateStore.getState>['marquee'],
  activeSelectionId: string | null,
): boolean {
  if (marquee) return isMaskableMarquee(marquee);
  return activeSelectionId !== null;
}

/** Masks modifier `modId` on `nodeId`; returns which route ran, or `undefined` when there was nothing to mask with. */
export function maskFromSelection(
  nodeId: string,
  modId: string,
): 'marquee' | 'selection' | undefined {
  const marqueeState = useMarqueeStateStore.getState();
  const store = useSceneStore.getState();
  const { marquee, params } = marqueeState;
  if (marquee) {
    if (!isMaskableMarquee(marquee)) return undefined;
    store.applyMarqueeAsVectorMask(nodeId, modId, marquee, params);
    // Consumed — same "no orphaned overlay state" rule as every other marquee exit.
    marqueeState.clear();
    return 'marquee';
  }
  const activeId = useActiveSelectionStore.getState().id;
  if (!activeId) return undefined;
  const consumerTransform = store.scene.nodes.find((n) => n.id === nodeId)?.transform2d;
  store.setModifierVectorMask(nodeId, modId, activeId, {
    featherPx: params.featherPx,
    expand: params.expand,
    invert: params.invert,
    space: 'node',
    attachTransform: { ...(consumerTransform ?? IDENTITY_TRANSFORM_2D) },
  });
  return 'selection';
}
