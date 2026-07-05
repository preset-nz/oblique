import { create } from 'zustand';
import type { Point, Rect } from './marqueeGeometry';

/**
 * The active marquee (features/05-selection/marquees.md). Sibling to
 * `toolState.ts` and `scene/selection.ts`, not a merge with either: it's
 * ephemeral *view* state, one active marquee at a time, keyed to whichever
 * `select-rect` / `select-ellipse` / `select-lasso` tool drew it.
 *
 * Deliberately never touches `scene/store.ts` or `scene/history.ts` — no
 * undo integration, no `.oblique` persistence, no dirty flags, zero cooks
 * fired (epic acceptance: marquees are ephemeral overlay state, not scene
 * state). `selection-to-mask.md` is the story that turns a marquee into
 * something the scene model knows about.
 */
export type MarqueeShape =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ellipse'; rect: Rect }
  | { kind: 'lasso'; points: Point[]; closed: boolean };

export interface MarqueeParams {
  /** Feather radius, document-space px (spatial param — scales with cook resolution like any other, starter-ops.md). Consumed by `selection-to-mask.md`, not yet. */
  featherPx: number;
  /** Expand (positive) / contract (negative) offset, document-space px. */
  expand: number;
  invert: boolean;
}

export const DEFAULT_MARQUEE_PARAMS: MarqueeParams = {
  featherPx: 0,
  expand: 0,
  invert: false,
};

interface MarqueeStateStore {
  marquee: MarqueeShape | null;
  params: MarqueeParams;
  /** Every drag/resize/move commits a whole new shape via this — `MarqueeBox`/`LassoMarquee`/`Viewport.tsx` all compute the next `MarqueeShape` themselves (pure functions in `marqueeGeometry.ts`) rather than patching the previous one in place. */
  setMarquee: (marquee: MarqueeShape | null) => void;
  setParams: (patch: Partial<MarqueeParams>) => void;
  /** Escape, tool-switch-away, Delete/Backspace all funnel through this — clears the marquee and resets its params so no stale feather/invert carries into the next one. */
  clear: () => void;
}

export const useMarqueeStateStore = create<MarqueeStateStore>((set) => ({
  marquee: null,
  params: DEFAULT_MARQUEE_PARAMS,
  setMarquee: (marquee) => set({ marquee }),
  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  clear: () => set({ marquee: null, params: DEFAULT_MARQUEE_PARAMS }),
}));
