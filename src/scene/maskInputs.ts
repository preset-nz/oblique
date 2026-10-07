import {
  isTextNode,
  isVectorNode,
  type Modifier,
  type SceneNode,
  type VectorMaskRef,
} from '@/scene/types';

/**
 * What a modifier's `maskId` resolves to, as cook inputs: the
 * `VectorMaskRef` plus the referenced node's live geometry. Shared by
 * `restore.ts` (an undo that only changes the referenced shape must dirty the
 * consumer) and cook.ts's race guard (a mask-source edit landing mid-cook
 * must leave the consumer dirty) so both read the same definition of
 * "the mask changed".
 *
 * The referenced shape's transform2d is a cook input too — document-pinned
 * masks rasterise at the shape's COMPOSITED position. A text target
 * (text-modifier-masks.md) is keyed by what shapes its glyph mask: the spec
 * fields + position. Fill/stroke are left out — the modifier mask is glyph
 * fill only, so they don't affect it.
 */
export function resolvedMaskInput(
  maskId: string | undefined,
  getRef: (maskId: string) => VectorMaskRef | undefined,
  getNode: (nodeId: string) => SceneNode | undefined,
): unknown {
  if (!maskId) return null;
  const ref = getRef(maskId);
  if (!ref) return null;
  const target = getNode(ref.nodeId);
  const geometry =
    target && isVectorNode(target)
      ? { paths: target.paths, fillRule: target.fillRule, transform2d: target.transform2d }
      : target && isTextNode(target)
        ? {
            text: {
              content: target.content,
              font: target.font,
              fontSize: target.fontSize,
              tracking: target.tracking,
              kerning: target.kerning,
              lineHeight: target.lineHeight,
              align: target.align,
              position: target.position,
            },
            transform2d: target.transform2d,
          }
        : null;
  return { ref, geometry };
}

/**
 * Whether any of `modifiers` carries a resolvable DOCUMENT-pinned mask
 * (`space` absent or `'document'`, mask-follows-node.md). Only such masks
 * rasterise through the consumer's CURRENT transform2d, so only they make the
 * consumer's transform a cook input — the one predicate behind
 * `setNodeTransform`'s dirty exception, cook.ts's race-guard key and
 * `restore.ts`'s `cookAffectingChanged`. A consumer whose masks are all
 * node-pinned goes back to "transform never recooks".
 */
export function hasDocumentPinnedMask(
  modifiers: Modifier[],
  getRef: (maskId: string) => VectorMaskRef | undefined,
): boolean {
  return modifiers.some((m) => {
    const ref = m.maskId ? getRef(m.maskId) : undefined;
    return ref !== undefined && ref.space !== 'node';
  });
}
