import * as cache from '@/scene/cache';
import * as prefixStore from '@/scene/prefixStore';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';

/**
 * Delete a node completely: scene entry, cook caches (bitmaps closed), its
 * prefix-cache intermediates, and the decoded source bitmap. `removeNode` alone would leak all three cache
 * levels plus the source ImageBitmap for the rest of the session.
 *
 * Deletion is compositing-only for the surviving nodes (dirty rule 4): no
 * dirty flag, no recook — the scene-store subscription recomposites.
 * Undoable (Epic 13) via the scene-store subscription in `scene/history.ts`
 * — `removeNode`'s scene mutation is captured as a normal undo step; undo
 * restores the node and `scene/history.ts` re-decodes its source bitmap
 * (evicted here) before the scheduler recooks it.
 */
export function deleteNode(nodeId: string): void {
  useSceneStore.getState().removeNode(nodeId);
  cache.clearNode(nodeId);
  prefixStore.clearNode(nodeId);
  sources.remove(nodeId);
}
