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
 *
 * `pen` (Epic 06, pen-tool.md) draws a `VectorNode` — its in-progress path
 * lives in `canvas/vector/penState.ts`, not here (same separation as
 * marquees: this store only ever answers "what does my pointer do").
 *
 * `select-smart` (Epic 17, segment-to-vector.md): click/Alt-click points and
 * a drag box prompt the sidecar's MobileSAM segmenter; its in-progress
 * prompt state lives in `canvas/smartSelect/state.ts`, same separation as
 * marquees/pen.
 */
export type Tool =
  | 'pan'
  | 'move'
  | 'select-rect'
  | 'select-ellipse'
  | 'select-lasso'
  | 'select-smart'
  | 'pen';

interface ToolStateStore {
  tool: Tool;
  setTool: (tool: Tool) => void;
}

export const useToolStateStore = create<ToolStateStore>((set) => ({
  tool: 'pan',
  setTool: (tool) => set({ tool }),
}));
