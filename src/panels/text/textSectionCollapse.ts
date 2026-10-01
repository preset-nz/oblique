import { create } from 'zustand';
import { useTextEditStore } from '@/scene/textEditState';

/**
 * Collapsed state of the Text inspector section: one global flag for every text
 * node (so folding it away to look at the modifier stack survives selecting
 * another text layer), per session and not persisted — the same where-and-how
 * as `panels/stack/rowCollapse.ts`.
 */
interface TextSectionState {
  collapsed: boolean;
  toggle: () => void;
  expand: () => void;
}

export const useTextSectionStore = create<TextSectionState>((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
  expand: () => set({ collapsed: false }),
}));

// A T-click, double-click or Enter asks the Text field to take focus. The field
// is unmounted while the section is collapsed, so the section must open first;
// the field then consumes the pending ask when it mounts.
useTextEditStore.subscribe((state, prev) => {
  if (state.focusRequest !== prev.focusRequest) useTextSectionStore.getState().expand();
});
