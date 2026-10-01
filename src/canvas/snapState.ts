import { create } from 'zustand';

/** A snap guide line in document space: a vertical line at `x`, a horizontal one at `y`. */
export interface SnapGuides {
  x?: number;
  y?: number;
}

/**
 * Ephemeral UI state for move-drag snapping (snapping.md). `enabled` mirrors
 * View -> Snap to Layers: the native check item is the source of truth (it
 * toggles itself on click) and `src/app/menu.ts` writes the checked state it is
 * sent here, so the two start in sync at `true`. Not persisted (the settings
 * story can pick that up). `guides` is what the Viewport overlay draws while an
 * axis is snapped; it is cleared on pointer-up. Never touches the scene store.
 */
interface SnapStore {
  enabled: boolean;
  guides: SnapGuides | null;
  setEnabled: (enabled: boolean) => void;
  setGuides: (guides: SnapGuides | null) => void;
}

export const useSnapStore = create<SnapStore>((set) => ({
  enabled: true,
  guides: null,
  setEnabled: (enabled) => set({ enabled }),
  setGuides: (guides) =>
    set((s) =>
      s.guides?.x === guides?.x && s.guides?.y === guides?.y && !s.guides === !guides
        ? s
        : { guides },
    ),
}));
