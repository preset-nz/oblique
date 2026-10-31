import { create } from 'zustand';
import { useSceneStore } from './store';

/**
 * The active selection (selections-panel.md): which saved selection node is "the" selection.
 * Its tint and outline show on the canvas in every tool (`canvas/ActiveSelectionOverlay.tsx`),
 * its row is highlighted in the Selections tab, and Mask from selection binds it when there is
 * no live marquee.
 *
 * View state, like the marquee: not in the document, not an undo step. Lives in `scene/` because
 * the canvas, the panels and the menu all read it and `src/panels/` and `src/canvas/` only meet
 * through stores. It clears itself when its node leaves the scene (New, Open, undo past its
 * creation, deletion), the same self-healing `canvas/selectShared/clearWhenTargetGone.ts` gives
 * the selection tools' stores; that helper is canvas code, so the few lines are repeated here.
 */
interface ActiveSelectionStore {
  /** The active selection node's id, or `null`. */
  id: string | null;
  activate: (id: string) => void;
  clear: () => void;
  /**
   * Bumped by Edit Shape. The panel can't switch tools itself (the tool state is canvas code),
   * so `Viewport` answers a change here by selecting the Move tool, the same shape as
   * `textEditState`'s `focusRequest`.
   */
  shapeEditRequest: number;
  requestShapeEdit: () => void;
}

export const useActiveSelectionStore = create<ActiveSelectionStore>((set) => ({
  id: null,
  activate: (id) => set({ id }),
  clear: () => set({ id: null }),
  shapeEditRequest: 0,
  requestShapeEdit: () => set((s) => ({ shapeEditRequest: s.shapeEditRequest + 1 })),
}));

useSceneStore.subscribe((state, prev) => {
  if (state.scene.nodes === prev.scene.nodes) return;
  const { id, clear } = useActiveSelectionStore.getState();
  if (id && !state.scene.nodes.some((n) => n.id === id)) clear();
});
