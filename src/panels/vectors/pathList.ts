import type { VectorPath } from '@/scene/types';

/**
 * Pure path-list surgery for the Vectors tab (vectors-tab.md). Deliberately
 * separate from `canvas/vector/pathEdit.ts` — that module is canvas-only
 * (panels never import `src/canvas/`, depcruise rule) and operates at
 * anchor granularity; this one operates at whole-path granularity, the
 * Vectors tab's own editing surface. Both funnel through the same
 * `useSceneStore.setVectorPaths` action, so dirtying/cross-node-mask-ref
 * behaviour lives in exactly one place regardless of which UI triggered it.
 */

/**
 * Removes a whole path (row-level delete). Mirrors `pathEdit.ts::deleteAnchor`'s
 * convention: a vector node left with zero paths has nothing left to
 * rasterise or edit, so the caller gets `null` as the cue to delete the
 * whole node (`scene/deleteNode.ts`) instead of writing an empty array.
 */
export function deletePath(paths: VectorPath[], pathIndex: number): VectorPath[] | null {
  const next = paths.filter((_, i) => i !== pathIndex);
  return next.length === 0 ? null : next;
}

/**
 * Moves the path at `fromIndex` to `toIndex` (the nudge pattern's
 * commit step — `panels/stack/LayerList.tsx::nudgeIndex` supplies the target
 * index / button-disable state, this just performs the splice).
 */
export function reorderPath(paths: VectorPath[], fromIndex: number, toIndex: number): VectorPath[] {
  const next = [...paths];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
