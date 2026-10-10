import { create } from 'zustand';

/**
 * Which side panels are showing: View > Show Left Panel (`Cmd+[`) and Show Right Panel (`Cmd+]`),
 * the family's bracket pattern (menu standard decision 14). Left is the tool rail, right the
 * tabbed side panel (`Layout.tsx`).
 *
 * View state, not document state: it never touches the scene store, takes no undo step and is
 * not saved in the `.oblique` file. In memory only, like the snap tick: there is no view
 * preferences store to put it in yet, so both panels are back on after a relaunch.
 */
interface PanelStore {
  left: boolean;
  right: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
}

export const usePanelStore = create<PanelStore>((set) => ({
  left: true,
  right: true,
  toggleLeft: () => set((s) => ({ left: !s.left })),
  toggleRight: () => set((s) => ({ right: !s.right })),
}));
