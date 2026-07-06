import { create } from 'zustand';

/**
 * Ephemeral UI state for direct-selection path editing (path-editing.md) —
 * which anchor is "active" (selected via click or the start of a drag), for
 * `Viewport.tsx`'s Delete/Backspace and Escape handlers to act on. Started
 * out canvas-local (nothing in `panels/` needed an in-progress path edit at
 * the time); moved here (vectors-tab.md) because the Vectors tab's path-row
 * click needs to write the same "active" concept `PathEditor.tsx` reads to
 * paint its amber highlight — one store, so canvas-side anchor clicks and
 * panel-side row clicks can never disagree about what's focused. Lives next
 * to `selection.ts`, the same kind of ephemeral cross-layer UI store. Never
 * touches the scene store itself — only `PathEditor.tsx`'s drag handlers
 * call `useSceneStore`'s `setVectorPaths`, on pointerup, exactly once per
 * completed drag.
 *
 * In-flight drag geometry (the live preview while dragging) is NOT here —
 * it's local `useState` inside `PathEditor.tsx`, scoped to one drag, same as
 * `TransformBox.tsx`'s `dragRef`. This store only tracks which anchor is
 * selected, so it can survive across a click (which doesn't drag) and be
 * read by Viewport's keydown handler and `VectorsPanel`'s row highlight.
 *
 * A "focused path" (from a Vectors-tab row click, no particular anchor in
 * mind) is represented as `{ pathIndex, anchorIndex: 0 }` — there is no
 * separate path-only concept, deliberately, so a row click and an on-canvas
 * anchor click stay one shared notion of "what's active" (see above).
 */
export interface ActiveAnchor {
  pathIndex: number;
  anchorIndex: number;
}

interface PathEditStateStore {
  activeAnchor: ActiveAnchor | null;
  setActiveAnchor: (anchor: ActiveAnchor | null) => void;
  /** Escape / tool-switch-away / selection-change: deselects the active anchor. */
  clear: () => void;
}

export const usePathEditStateStore = create<PathEditStateStore>((set) => ({
  activeAnchor: null,
  setActiveAnchor: (activeAnchor) => set({ activeAnchor }),
  clear: () => set({ activeAnchor: null }),
}));
