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
 * Undoable as a normal undo step (rhizome's; Epic 22 removed the snapshot history): undo
 * restores the node and `restoreScene` re-decodes its source bitmap (evicted here) before the
 * scheduler recooks it.
 *
 * **Eviction waits for the layer to be gone.** On rhizome `removeNode` sends `layer.remove`
 * and the store drops the layer when the update comes back (Epic 21 story 3), so evicting
 * on send would blank a layer the scene still has, and a refused remove (the host said no)
 * must leave its caches alone. The eviction runs on the store change that removes the layer.
 */
const waiting = new Map<string, () => void>();

function evict(nodeId: string): void {
  cache.clearNode(nodeId);
  prefixStore.clearNode(nodeId);
  sources.remove(nodeId);
}

const present = (nodeId: string): boolean =>
  useSceneStore.getState().scene.nodes.some((n) => n.id === nodeId);

export function deleteNode(nodeId: string): void {
  useSceneStore.getState().removeNode(nodeId);
  if (!present(nodeId)) {
    evict(nodeId); // removed in place (the store's own action)
    return;
  }
  if (waiting.has(nodeId)) return;
  // Still there: the update that removes it is on its way, or the remove was refused, in which
  // case the layer stays and the wait ends only if it goes some other way (an undo of its add).
  const off = useSceneStore.subscribe(() => {
    if (present(nodeId)) return;
    off();
    waiting.delete(nodeId);
    evict(nodeId);
  });
  waiting.set(nodeId, off);
}
