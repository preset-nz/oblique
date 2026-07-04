import { create } from 'zustand';

/**
 * Tool state machine (tool-state.md). Sibling to `src/scene/selection.ts`,
 * not a merge: node selection is "which node am I editing," tool state is
 * "what does my pointer currently do." UI-only — never persisted, never
 * touches the scene store (resets to `pan` on every app restart).
 *
 * `select-rect` / `select-ellipse` / `select-lasso` exist in the type and
 * the toolbar now so the marquee story (marquees.md) has buttons to wire
 * up; marquee drawing itself is out of scope here.
 */
export type Tool = 'pan' | 'move' | 'select-rect' | 'select-ellipse' | 'select-lasso';
// future: 'pen' (Epic 06 vector authoring)

interface ToolStateStore {
  tool: Tool;
  setTool: (tool: Tool) => void;
}

export const useToolStateStore = create<ToolStateStore>((set) => ({
  tool: 'pan',
  setTool: (tool) => set({ tool }),
}));
