/**
 * Prefix-cache helpers (design/prefix-caching.md, story prefix-cache.md):
 * the pure descriptor/diff functions `cookNode` uses to decide what it may
 * reuse. Storage (map, LRU, clear hooks) lives in `scene/prefixStore.ts` —
 * `scene/` has to be able to clear it and may not import `cook/` — and is
 * re-exported here so the cook side has one import.
 *
 * Correctness posture: a stale prefix paints wrong pixels silently, so every
 * input that can change a prefix's bytes is folded into a descriptor string,
 * and anything doubtful is simply included (an extra field can only cause a
 * miss, never a wrong hit).
 */
import { hasDocumentPinnedMask, resolvedMaskInput } from '@/scene/maskInputs';
import { textCookKey } from '@/scene/textGeometryCache';
import type { PixelNode, SceneNode, TextNode, VectorMaskRef, VectorNode } from '@/scene/types';
import type { OpDescriptor } from '@/sidecar/opsCache';

export {
  clearAll,
  clearNode,
  getLastStack,
  getPrefix,
  PREFIX_NODE_CAP,
  type PrefixDescriptor,
  type PrefixEntry,
  type PrefixLevel,
  setLastStack,
  setPrefix,
} from '@/scene/prefixStore';

/** What `descriptorsFor` reads from the outside world — a subset of `CookDeps`. */
export interface DescriptorDeps {
  getNode: (nodeId: string) => SceneNode | undefined;
  getVectorMaskRef: (maskId: string) => VectorMaskRef | undefined;
  getDocumentSize: () => [number, number];
  getOps: () => OpDescriptor[];
}

/** The node's own extent a cook scales from: pixel `sourceSize`, else the document (vector/text rasters span it). */
function extentFor(
  node: PixelNode | VectorNode | TextNode,
  deps: Pick<DescriptorDeps, 'getDocumentSize'>,
): [number, number] {
  return node.type === 'pixel' ? node.sourceSize : deps.getDocumentSize();
}

/**
 * Identity of a node's source pixels (before any modifier):
 * - pixel: the `ImageBitmap` itself, compared with `===` (`sources.set`
 *   replaces the object on any reload);
 * - vector: `{paths, fillRule}` JSON — all `rasterizeVector` reads;
 * - text: `textCookKey(node)` — spec, position, fill, stroke.
 * `transform2d` is deliberately not part of it: a node's raster is produced
 * untransformed (node-transform-2d.md); masks that read it carry it in their
 * own modifier descriptor.
 */
export function sourceKeyFor(
  node: PixelNode | VectorNode | TextNode,
  pixelSource: ImageBitmap | undefined,
): ImageBitmap | string | undefined {
  if (node.type === 'pixel') return pixelSource;
  if (node.type === 'text') return textCookKey(node);
  return JSON.stringify({ paths: node.paths, fillRule: node.fillRule });
}

/**
 * One descriptor string per ENABLED modifier, in stack order — exactly the
 * modifiers `buildCookModifiers` turns into `CookModifier`s (1:1, same order).
 * Document-space: the scene's `Modifier`, not the factor-scaled run params.
 *
 * Each string folds in everything that modifier's output depends on beyond
 * the previous modifier's pixels:
 * - the modifier itself (type, params, enabled, id, maskId);
 * - its resolved mask inputs (`resolvedMaskInput`: the whole ref + target
 *   geometry for vector and text targets);
 * - when it has a mask: the document size and this node's extent (both feed
 *   the mask raster), and the consumer's `transform2d` iff THAT modifier's
 *   ref is document-pinned (a node-pinned ref reads `attachTransform`, which
 *   is already inside the ref);
 * - the op's registry facts that change how params are prepared (backend and
 *   which params are `spatial`-scaled) — a cook that ran before `list_ops`
 *   answered passed params through unscaled, and its bytes must not match
 *   once the registry is known.
 */
export function descriptorsFor(
  node: PixelNode | VectorNode | TextNode,
  deps: DescriptorDeps,
): string[] {
  const ops = new Map(deps.getOps().map((o) => [o.name, o]));
  const extent = extentFor(node, deps);
  return node.modifiers
    .filter((m) => m.enabled)
    .map((m) => {
      const mask = resolvedMaskInput(m.maskId, deps.getVectorMaskRef, deps.getNode);
      const op = ops.get(m.type);
      return JSON.stringify({
        modifier: m,
        mask,
        maskFrame:
          mask === null
            ? undefined
            : {
                documentSize: deps.getDocumentSize(),
                extent,
                consumerTransform2d: hasDocumentPinnedMask([m], deps.getVectorMaskRef)
                  ? (node.transform2d ?? null)
                  : undefined,
              },
        op: op
          ? {
              backend: op.backend,
              spatial: op.params.filter((p) => p.scale === 'spatial').map((p) => p.name),
            }
          : null,
      });
    });
}

/** `a` is a prefix of (or equal to) `b`. The empty list is a prefix of everything. */
export function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Index of the first element where `a` and `b` differ; when one is a prefix
 * of the other, the shorter length (the first index only one side has).
 * Equal lists return that common length.
 */
export function firstDiff(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/** Element-wise equality. */
export function sameDescriptors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && isPrefix(a, b);
}
