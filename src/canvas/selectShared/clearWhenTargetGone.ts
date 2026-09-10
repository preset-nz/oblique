import { useSceneStore } from '@/scene/store';

/**
 * Self-healing for the selection tools' stores (`smartSelect/state.ts`,
 * `colourSelect/state.ts`): whenever the scene's node list changes and the
 * store's target node is no longer in it — New project, Open project, undo
 * past the node's creation, or plain layer deletion — the store clears
 * itself. Without this the prompt markers and the polygons preview keep
 * floating over a scene that no longer contains the image they were made
 * from (Georg, 2026-09-10: Cmd+N mid colour-select).
 *
 * Installed once at module load by each store (module-level subscription,
 * same posture as `cook/singleton.ts`). Returns the unsubscribe for tests.
 */
export function clearWhenTargetGone(
  getTargetNodeId: () => string | null,
  clear: () => void,
): () => void {
  return useSceneStore.subscribe((state, prev) => {
    if (state.scene.nodes === prev.scene.nodes) return;
    const target = getTargetNodeId();
    if (!target) return;
    if (!state.scene.nodes.some((n) => n.id === target)) clear();
  });
}
