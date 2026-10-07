import type { ImportDeps } from '@/project/import';
import { useProjectMetaStore } from '@/project/projectMeta';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import { isPixelNode } from '@/scene/types';

/**
 * Duplicate a node (duplicate-node.md, Tier 1): the store action does the
 * scene surgery; this drives the source-bitmap map the scene deliberately
 * doesn't contain. Sibling to `deleteNode.ts`.
 *
 * Ordering matters: a pixel node's source is decoded BEFORE the store is
 * touched, so no dirty node ever exists without a source for the scheduler to
 * cook into. The bitmap is re-decoded, never shared with the original —
 * `sources.set`/`remove` close what they evict, so a shared `ImageBitmap`
 * would be closed under the survivor on the first delete.
 *
 * Undo/redo need nothing here: rhizome records the scene change and
 * `restoreScene` re-decodes any pixel node missing from `sources`.
 */
export async function duplicateNode(nodeId: string, deps: ImportDeps): Promise<string | null> {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  let bitmap: ImageBitmap | null = null;
  let missingReason: sources.SourceMissingReason = 'not-found';
  if (isPixelNode(node)) {
    // Through the shared resolver (image-source.md). A file moved/deleted since
    // import still duplicates (re-hydration contract, pixel-node-import.md) —
    // the copy gets the striped placeholder.
    const load = await sources.loadSource(
      node.sourcePath,
      useProjectMetaStore.getState().path,
      deps,
    );
    if (load.ok) bitmap = load.bitmap;
    else missingReason = load.reason;
  }

  // The scene may have changed while decoding; the store no-ops to null if the node went.
  const newId = useSceneStore.getState().duplicateNode(nodeId);
  if (!newId) {
    (bitmap as sources.Closable | null)?.close?.();
    return null;
  }

  // No await between the store action and the source registration.
  if (isPixelNode(node)) {
    if (bitmap) {
      sources.set(newId, bitmap);
      sources.useSourceMissingStore.getState().clear(newId);
    } else {
      sources.useSourceMissingStore.getState().setMissing(newId, true, missingReason);
    }
  }
  return newId;
}
