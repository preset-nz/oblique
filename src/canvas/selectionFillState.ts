import { create } from 'zustand';

/**
 * The tint inside a selection shape (selection-fill-overlay.md): the marquee outline's colour at
 * 18% opacity. Fixed, not a Setting; the roadmap's colour pass retunes this and the outline
 * (`#38bdf8` in `MarqueeBox`, `LassoMarquee`, `SmartSelectOverlay`, `ColourSelectOverlay`)
 * together.
 */
export const SELECTION_FILL_COLOUR = '#38bdf8';
export const SELECTION_FILL_OPACITY = 0.18;

/**
 * Ephemeral UI state for View -> Show Selection Fill, shaped like `snapState.ts`: the menu's click
 * runs `src/app/menu.ts`, which flips `enabled`, and the tick is pushed back to the native item
 * from there (app-kit's `useMenuSync`), so the two start in sync at `true`. Not persisted, so it
 * starts on at every launch. View state: not an undo step, never touches the scene store.
 */
interface SelectionFillStore {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useSelectionFillStore = create<SelectionFillStore>((set) => ({
  enabled: true,
  setEnabled: (enabled) => set({ enabled }),
}));
