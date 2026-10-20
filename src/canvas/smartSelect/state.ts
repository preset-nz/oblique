import { create } from 'zustand';
import { clearWhenTargetGone } from '@/canvas/selectShared/clearWhenTargetGone';

/**
 * The `select-smart` tool's in-progress prompt (Epic 17, segment-to-vector.md).
 * Sibling to `scene/marquee.ts` and `canvas/vector/penState.ts`, not a merge
 * with either: ephemeral *view* state, one active prompt at a time, keyed to
 * the `select-smart` tool. `Viewport.tsx` and `canvas/smartSelect/controller.ts`
 * are the only writers; `SmartSelectOverlay.tsx` only reads.
 *
 * Document-space throughout (points/box) — the buffer-space mapping for the
 * actual sidecar request lives in `coords.ts` and is applied only at request
 * time, never stored here (same "screen space exists only at pointer-event
 * and paint edges" discipline, one level in from document space).
 */

export interface SmartSelectPoint {
  x: number;
  y: number;
  /** 1 = positive (include), 0 = negative (exclude) — SAM's own convention, kept verbatim through the wire contract. */
  label: 0 | 1;
}

export interface SmartSelectBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * `model_missing`: MobileSAM was removed while the tool was armed (model-downloads.md). Choosing
 * the tool again asks to download it.
 */
export type SmartSelectStatus = 'idle' | 'pending' | 'model_missing' | 'error';

interface SmartSelectState {
  /** The node being segmented — the tool's selected node at activation (must stay selected). */
  targetNodeId: string | null;
  points: SmartSelectPoint[];
  box: SmartSelectBox | null;
  /**
   * The outline prompt's rasterised 256x256 coarse mask (document-space
   * outline, already downsampled — `outlinePrompt.ts`'s job), sent once on
   * the first request after activation. `null` for an ordinary point/box
   * prompt with nothing seeded.
   */
  outlineMask: Uint8Array | null;
  status: SmartSelectStatus;
  error: string | null;

  /** Activates the tool against a node, discarding any previous prompt (a new target is a fresh gesture). */
  setTarget: (nodeId: string | null) => void;
  /** Click (label 1) / Alt-click (label 0): appends to the CURRENT prompt — refines a box or an outline seed, same as SAM's own point+box combination. */
  addPoint: (point: { x: number; y: number }, label: 0 | 1) => void;
  /**
   * Drag box (>= 4px): REPLACES the whole prompt with just the new box — a
   * drag is a fresh "select roughly this region" gesture, same "whole new
   * shape, not a patch" convention `scene/marquee.ts`'s `setMarquee`
   * documents for its own drag-replace behaviour.
   */
  setBox: (box: SmartSelectBox) => void;
  /** Outline-prompt seed (segment-to-vector.md's outline-prompt note): box + coarse mask from an active marquee or the selected vector node, consumed on activation only. */
  seedOutline: (box: SmartSelectBox, mask: Uint8Array) => void;
  setStatus: (status: SmartSelectStatus, error?: string) => void;
  /**
   * Escape, Delete/Backspace: drops the prompt (points/box/outline/status)
   * but keeps `targetNodeId` — the tool stays live against the same node,
   * ready for a fresh click/drag. Escape ending the WHOLE tool (as it does
   * for `clear()`, below) would leave `select-smart` needing a tool-switch
   * round trip before it could be used again — `setTarget` is the only
   * writer of `targetNodeId` outside `clear()`, and it only runs on
   * activation (Viewport's tool-switch effect).
   */
  clearPrompt: () => void;
  /** Tool-switch-away: clears the whole prompt AND the target — no orphaned overlay state, same rule every other tool follows. */
  clear: () => void;
}

const INITIAL: Pick<
  SmartSelectState,
  'targetNodeId' | 'points' | 'box' | 'outlineMask' | 'status' | 'error'
> = {
  targetNodeId: null,
  points: [],
  box: null,
  outlineMask: null,
  status: 'idle',
  error: null,
};

const PROMPT_ONLY: Pick<SmartSelectState, 'points' | 'box' | 'outlineMask' | 'status' | 'error'> = {
  points: [],
  box: null,
  outlineMask: null,
  status: 'idle',
  error: null,
};

export const useSmartSelectStore = create<SmartSelectState>((set) => ({
  ...INITIAL,
  setTarget: (nodeId) => set({ ...INITIAL, targetNodeId: nodeId }),
  addPoint: (point, label) =>
    set((s) => ({ points: [...s.points, { x: point.x, y: point.y, label }] })),
  setBox: (box) => set({ box, points: [], outlineMask: null }),
  seedOutline: (box, mask) => set({ box, outlineMask: mask, points: [] }),
  setStatus: (status, error) => set({ status, error: error ?? null }),
  clearPrompt: () => set({ ...PROMPT_ONLY }),
  clear: () => set({ ...INITIAL }),
}));

clearWhenTargetGone(
  () => useSmartSelectStore.getState().targetNodeId,
  () => useSmartSelectStore.getState().clear(),
);

/**
 * True once there's enough of a prompt to fire a segment request: at least
 * one point, or a box (outline-seeded or dragged). Pure so
 * `controller.ts`/tests don't need the store's React glue.
 */
export function hasPrompt(state: Pick<SmartSelectState, 'points' | 'box'>): boolean {
  return state.points.length > 0 || state.box !== null;
}
