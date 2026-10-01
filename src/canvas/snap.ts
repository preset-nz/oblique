/**
 * Pure snapping maths for the move drag (snapping.md). Everything here is
 * document space except `SNAP_SCREEN_PX` / `snapToleranceDoc`, which is the one
 * conversion from the screen-space feel ("6 px of pull") to the document units
 * the rest of the module works in — done at the pointer edge through the shared
 * `viewTransform` scale, like the lasso/pen close radii in Viewport.
 */

/** How close (screen px) a moving edge/centre must come to a target before it snaps. */
export const SNAP_SCREEN_PX = 6;

/** Snap tolerance in document units at the given `viewTransform` scale (document px -> screen px). */
export function snapToleranceDoc(viewScale: number): number {
  return SNAP_SCREEN_PX / Math.max(viewScale, 0.0001);
}

/** Axis-aligned box in document space (structurally `hitTest.ts`'s `Rect`). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Snap target coordinates per axis: vertical lines (`xs`) and horizontal lines (`ys`). */
export interface SnapTargets {
  xs: number[];
  ys: number[];
}

export interface AxisSnap {
  /** Add this to the moving coordinates to land on the target. */
  delta: number;
  /** The target coordinate that was snapped to (where the guide is drawn). */
  at: number;
}

/**
 * Closest candidate/target pair within `tol` (inclusive), or `null` when
 * nothing is in range. The smallest |delta| wins; an exact |delta| tie keeps
 * the first pair in candidate-then-target order, so the result is
 * deterministic (a drag never flickers between two equidistant lines).
 */
export function snapAxis(candidates: number[], targets: number[], tol: number): AxisSnap | null {
  let best: AxisSnap | null = null;
  for (const c of candidates) {
    for (const t of targets) {
      const delta = t - c;
      if (Math.abs(delta) > tol) continue;
      if (best === null || Math.abs(delta) < Math.abs(best.delta)) best = { delta, at: t };
    }
  }
  return best;
}

export interface MoveSnap {
  dx: number;
  dy: number;
  /** Document x of the vertical guide, when the x axis snapped. */
  guideX?: number;
  /** Document y of the horizontal guide, when the y axis snapped. */
  guideY?: number;
}

/**
 * Snaps a moving box (already offset by the un-snapped proposed delta) to
 * `targets`: its left/centre/right against `xs` and top/middle/bottom against
 * `ys`, each axis independently. Returns the extra offset to add, plus a guide
 * coordinate for every axis that snapped.
 */
export function snapMove(movingBox: Box, targets: SnapTargets, tol: number): MoveSnap {
  const { x, y, w, h } = movingBox;
  const sx = snapAxis([x, x + w / 2, x + w], targets.xs, tol);
  const sy = snapAxis([y, y + h / 2, y + h], targets.ys, tol);
  const out: MoveSnap = { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0 };
  if (sx) out.guideX = sx.at;
  if (sy) out.guideY = sy.at;
  return out;
}
