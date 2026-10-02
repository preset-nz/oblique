import { create } from 'zustand';

/**
 * Collapsed state of the Image inspector section: one global flag for every
 * pixel node (so folding it away to look at the modifier stack survives
 * selecting another image layer), per session and not persisted — the same
 * where-and-how as `panels/text/textSectionCollapse.ts`.
 */
interface ImageSectionState {
  collapsed: boolean;
  toggle: () => void;
}

export const useImageSectionStore = create<ImageSectionState>((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}));
