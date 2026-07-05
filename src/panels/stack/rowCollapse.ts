import { create } from 'zustand';

/**
 * Expand/collapse state for stack rows, keyed by modifier id (globally
 * unique — `crypto.randomUUID()` per modifier). Deliberately NOT keyed by
 * selection/node: nothing here ever clears on a selection change, which is
 * exactly what "row collapse state survives selection changes" (epic
 * acceptance) requires — reselecting the same node just reads the same
 * modId keys back.
 */
interface RowCollapseState {
  expanded: Record<string, boolean>;
  toggle: (modId: string) => void;
  /** Freshly created modifiers (add / duplicate) start expanded. */
  expand: (modId: string) => void;
  isExpanded: (modId: string) => boolean;
}

export const useRowCollapseStore = create<RowCollapseState>((set, get) => ({
  expanded: {},
  toggle: (modId) => set((s) => ({ expanded: { ...s.expanded, [modId]: !s.expanded[modId] } })),
  expand: (modId) => set((s) => ({ expanded: { ...s.expanded, [modId]: true } })),
  isExpanded: (modId) => Boolean(get().expanded[modId]),
}));
