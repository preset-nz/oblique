import { create } from 'zustand';

/**
 * Ephemeral canvas-side state for direct-selection path editing
 * (path-editing.md) — which anchor is "active" (selected via click or the
 * start of a drag), for `Viewport.tsx`'s Delete/Backspace and Escape
 * handlers to act on. Same role `usePenStateStore`/`useMarqueeStateStore`
 * play for their tools: lives in `canvas/` (nothing in `panels/` needs an
 * in-progress path edit), never touches the scene store itself — only
 * `PathEditor.tsx`'s drag handlers call `useSceneStore`'s `setVectorPaths`,
 * on pointerup, exactly once per completed drag.
 *
 * In-flight drag geometry (the live preview while dragging) is NOT here —
 * it's local `useState` inside `PathEditor.tsx`, scoped to one drag, same as
 * `TransformBox.tsx`'s `dragRef`. This store only tracks which anchor is
 * selected, so it can survive across a click (which doesn't drag) and be
 * read by Viewport's keydown handler.
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
