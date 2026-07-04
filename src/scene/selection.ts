import { create } from 'zustand';

/**
 * Discriminated-union selection store, M&T/Strata shape (port the shape,
 * not the code — see design/property-editors.md's "Lift selection / layout
 * stores" note). Clicking a layer row in the Layers panel (Epic 03) selects
 * the node; the Stack tab reads this to know which node's modifier stack to
 * render.
 */
export type Selection = { kind: 'none' } | { kind: 'node'; nodeId: string };

interface SelectionStore {
  selection: Selection;
  selectNode: (nodeId: string) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionStore>((set) => ({
  selection: { kind: 'none' },
  selectNode: (nodeId) => set({ selection: { kind: 'node', nodeId } }),
  clear: () => set({ selection: { kind: 'none' } }),
}));
