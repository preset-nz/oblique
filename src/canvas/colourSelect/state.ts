import { create } from 'zustand';
import {
  type ColourSeed,
  type ColourSelectParams,
  DEFAULT_COLOUR_SELECT_PARAMS,
} from '@/ai/sidecarSelectColour';
import { clearWhenTargetGone } from '@/canvas/selectShared/clearWhenTargetGone';

/**
 * The `select-colour` tool's in-progress prompt (Epic 17 story 2b,
 * colour-range-select.md) — the magic wand. Sibling to
 * `canvas/smartSelect/state.ts`, deliberately not a merge with it: this
 * tool has no box/outline/download-progress concepts, but it does have its
 * own request params (tolerance/contiguous/space/expand/minIsland) that
 * `select-smart` has no equivalent of — the sidecar picks those up from
 * `ml/colour.py`'s pure-NumPy algorithm, not from any model weights, so
 * they live here rather than being bolted onto `smartSelect/state.ts`.
 *
 * Document-space throughout (`seeds`) — the buffer-space mapping happens
 * only at request time in `controller.ts`, same discipline
 * `smartSelect/state.ts` documents for its own points/box.
 */

export type ColourSelectStatus = 'idle' | 'pending' | 'error';

interface ColourSelectState {
  /** The node being sampled — the tool's selected node at activation (must stay selected). */
  targetNodeId: string | null;
  seeds: ColourSeed[];
  params: ColourSelectParams;
  status: ColourSelectStatus;
  error: string | null;

  /** Activates the tool against a node, discarding any previous prompt (a new target is a fresh gesture) — params survive (they're a tool-wide preference, not per-gesture). */
  setTarget: (nodeId: string | null) => void;
  /** Plain click / Alt-click: REPLACES the whole seed set with just this one seed — a fresh "start here" gesture, mirroring `scene/marquee.ts`'s own "whole new shape, not a patch" convention. */
  setSeed: (point: { x: number; y: number }, label: 0 | 1) => void;
  /** Shift-click: ADDS a seed to the current set — the story's own "Shift-click adds" contract. */
  addSeed: (point: { x: number; y: number }, label: 0 | 1) => void;
  setParams: (patch: Partial<ColourSelectParams>) => void;
  setStatus: (status: ColourSelectStatus, error?: string) => void;
  /** Escape, Delete/Backspace: drops the seeds/status but keeps `targetNodeId` and `params` — same "tool stays live" rule `smartSelect/state.ts`'s `clearPrompt` documents. */
  clearPrompt: () => void;
  /** Tool-switch-away: clears everything including the target — no orphaned overlay state. Params reset to defaults (a fresh activation is a fresh tool-wide preference set, matching the params panel always starting from the same defaults). */
  clear: () => void;
}

const PROMPT_ONLY: Pick<ColourSelectState, 'seeds' | 'status' | 'error'> = {
  seeds: [],
  status: 'idle',
  error: null,
};

const INITIAL: Pick<ColourSelectState, 'targetNodeId' | 'seeds' | 'params' | 'status' | 'error'> = {
  targetNodeId: null,
  seeds: [],
  params: DEFAULT_COLOUR_SELECT_PARAMS,
  status: 'idle',
  error: null,
};

export const useColourSelectStore = create<ColourSelectState>((set) => ({
  ...INITIAL,
  setTarget: (nodeId) => set((s) => ({ ...PROMPT_ONLY, targetNodeId: nodeId, params: s.params })),
  setSeed: (point, label) => set({ seeds: [{ x: point.x, y: point.y, label }] }),
  addSeed: (point, label) =>
    set((s) => ({ seeds: [...s.seeds, { x: point.x, y: point.y, label }] })),
  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  setStatus: (status, error) => set({ status, error: error ?? null }),
  clearPrompt: () => set({ ...PROMPT_ONLY }),
  clear: () => set({ ...INITIAL }),
}));

clearWhenTargetGone(
  () => useColourSelectStore.getState().targetNodeId,
  () => useColourSelectStore.getState().clear(),
);

/** True once there's at least one seed to fire a request for — pure so `controller.ts`/tests don't need the store's React glue, mirroring `smartSelect/state.ts`'s `hasPrompt`. */
export function hasSeeds(state: Pick<ColourSelectState, 'seeds'>): boolean {
  return state.seeds.length > 0;
}
