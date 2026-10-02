import type { ImportDeps } from '@/project/import';
import { useProjectMetaStore } from '@/project/projectMeta';
import { resolveSourcePath } from '@/project/resolvePath';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import { isPixelNode } from '@/scene/types';

/**
 * Point a pixel node at a different file (image-source.md). The store action
 * (`setPixelSource`) does the scene surgery in one mutation; this drives the
 * source-bitmap map and missing flag the scene deliberately doesn't contain.
 * Sibling to `duplicateNode.ts` and shaped like it: injected `ImportDeps`, the
 * bitmap is decoded BEFORE the store is touched, and `sources.set` runs before
 * the store action so the recomposite it triggers already has the pixels.
 *
 * `typed` is stored verbatim (no trimming, `~` expansion or absolutising). The
 * node's label is never touched. Undo/redo need nothing here: `history.ts`
 * captures the one scene change and `restoreScene` re-decodes when the path
 * differs.
 */

export type ReplaceSourceResult =
  | { ok: true; missing: boolean }
  /** `unsupported-scheme`: `strata://…` or any `scheme://` — refused, nothing changed. */
  | { ok: false; reason: 'unsupported-scheme' | 'locked' | 'no-node' | 'stale' };

/**
 * Per-node replace generation. A decode that comes back after the node was
 * replaced again (or deleted) finds its generation superseded and drops its
 * bitmap instead of landing it.
 */
const generations = new Map<string, number>();

export async function replacePixelSource(
  nodeId: string,
  typed: string,
  deps: ImportDeps,
): Promise<ReplaceSourceResult> {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (!node || !isPixelNode(node)) return { ok: false, reason: 'no-node' };
  if (node.state === 'locked') return { ok: false, reason: 'locked' };

  const projectPath = useProjectMetaStore.getState().path;
  const resolved = resolveSourcePath(typed, projectPath);
  if (resolved.kind === 'unresolvable' && resolved.reason === 'unsupported-scheme') {
    return { ok: false, reason: 'unsupported-scheme' };
  }

  // The same path on a healthy node is a no-op; on a missing node it is a retry
  // (the file may exist now).
  if (typed === node.sourcePath && !sources.isSourceMissing(nodeId)) {
    return { ok: true, missing: false };
  }

  const generation = (generations.get(nodeId) ?? 0) + 1;
  generations.set(nodeId, generation);

  const load = await sources.loadSource(typed, projectPath, deps);

  // Stale guard: deleted, locked, or replaced again while decoding.
  const live = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (
    !live ||
    !isPixelNode(live) ||
    live.state === 'locked' ||
    generations.get(nodeId) !== generation
  ) {
    if (load.ok) (load.bitmap as sources.Closable).close?.();
    return { ok: false, reason: 'stale' };
  }

  const store = useSceneStore.getState();
  if (load.ok) {
    // No await between here and the store action.
    sources.applySourceLoad(nodeId, load);
    store.setPixelSource(nodeId, typed, [load.bitmap.width, load.bitmap.height]);
    return { ok: true, missing: false };
  }

  // Accepted but missing (decision 4): path only, so the striped placeholder
  // keeps the old footprint and a later relink still has a box to fit into.
  // Source and flag first: the compositor only reads the missing flag when the
  // scene change below makes it repaint.
  sources.remove(nodeId);
  sources.applySourceLoad(nodeId, load);
  store.setPixelSource(nodeId, typed);
  return { ok: true, missing: true };
}
