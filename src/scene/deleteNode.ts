import * as cache from '@/scene/cache';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';

/**
 * Delete a node completely: scene entry, cook caches (bitmaps closed), and
 * the decoded source bitmap. `removeNode` alone would leak all three cache
 * levels plus the source ImageBitmap for the rest of the session.
 *
 * Deletion is compositing-only for the surviving nodes (dirty rule 4): no
 * dirty flag, no recook — the scene-store subscription recomposites.
 * No undo until Epic 13; the layer row's trash button is the only caller.
 */
export function deleteNode(nodeId: string): void {
  useSceneStore.getState().removeNode(nodeId);
  cache.clearNode(nodeId);
  sources.remove(nodeId);
}
