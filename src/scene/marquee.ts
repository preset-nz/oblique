import { create } from 'zustand';
import type { MaskShape } from './types';

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The active marquee (features/05-selection/marquees.md). Sibling to
 * `canvas/toolState.ts` and `scene/selection.ts`, not a merge with either:
 * it's ephemeral *view* state, one active marquee at a time, keyed to
 * whichever `select-rect` / `select-ellipse` / `select-lasso` tool drew it.
 * Lives in `scene/` (not `canvas/marquees/` with its renderers) because
 * both the canvas overlay and the stack panel's "Mask from selection"
 * action read it, and panels/canvas only meet via stores (depcruise rule).
 * The local `Point`/`Rect` shapes are structurally identical to
 * `canvas/marquees/marqueeGeometry.ts`'s.
 *
 * Deliberately never touches `scene/store.ts` or `scene/history.ts` — no
 * undo integration, no `.oblique` persistence, no dirty flags, zero cooks
 * fired (epic acceptance: marquees are ephemeral overlay state, not scene
 * state). `selection-to-mask.md`'s apply action is what turns a marquee
 * into something the scene model knows about.
 */
export type MarqueeShape =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ellipse'; rect: Rect }
  | { kind: 'lasso'; points: Point[]; closed: boolean };

/**
 * True when the active marquee is a finished shape a mask can rasterise
 * from: a rect/ellipse with real area, or a closed lasso with enough
 * points. Mirrors `marqueeGeometry.ts`'s isDrawnRect/isDrawnLasso bounds
 * (kept in sync by scene/marquee.test.ts, not by importing canvas code).
 */
export function isMaskableMarquee(marquee: MarqueeShape | null): boolean {
  if (!marquee) return false;
  if (marquee.kind === 'lasso') return marquee.closed && marquee.points.length >= 3;
  return marquee.rect.w >= 1 && marquee.rect.h >= 1;
}

/** The marquee's geometry as a persistable `MaskShape` (drops the lasso's transient `closed` flag). */
export function marqueeToMaskShape(marquee: MarqueeShape): MaskShape {
  if (marquee.kind === 'lasso') return { kind: 'lasso', points: marquee.points };
  return { kind: marquee.kind, rect: marquee.rect };
}

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
