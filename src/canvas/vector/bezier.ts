import type { Point2D } from '@/scene/types';

/**
 * Cubic Bezier maths — the TS port decision (epic 06 README: "adopt bezier-rs
 * option (b), port just the needed functions rather than pull in WASM").
 * Everything here is pure and stateless: no VectorNode/store knowledge, just
 * point/control-point arithmetic, so `pathEdit.ts` and `PathEditor.tsx` can
 * both lean on it without a circular import.
 *
 * A "cubic" here is always the 4 control points `[p0, c1, c2, p1]` — for a
 * straight segment (no handles either side) the caller passes the degenerate
 * cubic `p0, p0, p1, p1` (a corner-to-corner line is a valid, if pointless,
 * cubic), which is why the projection/subdivision maths below is never
 * special-cased for lines — `segmentCommand` in `vectorRasterize.ts` picks
 * `lineTo` vs `bezierCurveTo` for *rendering*; this module always thinks in
 * cubics for hit-testing/insertion, which need one shared representation.
 */

export interface Cubic {
  p0: Point2D;
  c1: Point2D;
  c2: Point2D;
  p1: Point2D;
}

/** de Casteljau: the point on `cubic` at parameter `t` (0..1). */
export function cubicPointAt(cubic: Cubic, t: number): Point2D {
  const { p0, c1, c2, p1 } = cubic;
  const lerp = (a: Point2D, b: Point2D): Point2D => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const ab = lerp(p0, c1);
  const bc = lerp(c1, c2);
  const cd = lerp(c2, p1);
  const abc = lerp(ab, bc);
  const bcd = lerp(bc, cd);
  return lerp(abc, bcd);
}

/**
 * de Casteljau subdivision: splits `cubic` at parameter `t` into two cubics
 * that together trace exactly the same curve as the original (shape
 * preservation is what `pathEdit.ts`'s insert-anchor surgery leans on — the
 * two halves' control points come straight out of the construction, not a
 * re-fit). `t` outside `[0, 1]` is not meaningful and is not guarded here —
 * callers (`closestPointOnCubic`) always clamp first.
 */
export function splitCubicAt(cubic: Cubic, t: number): { left: Cubic; right: Cubic } {
  const { p0, c1, c2, p1 } = cubic;
  const lerp = (a: Point2D, b: Point2D): Point2D => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const ab = lerp(p0, c1);
  const bc = lerp(c1, c2);
  const cd = lerp(c2, p1);
  const abc = lerp(ab, bc);
  const bcd = lerp(bc, cd);
  const abcd = lerp(abc, bcd);
  return {
    left: { p0, c1: ab, c2: abc, p1: abcd },
    right: { p0: abcd, c1: bcd, c2: cd, p1 },
  };
}

function distSq(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Closest point on `cubic` to `point`: coarse uniform sampling to bracket the
 * minimum, then a few rounds of ternary-search refinement around the best
 * sample. Not a closed-form/Newton solve (bezier-rs uses one; a bisection
 * search is a handful of lines and easy to verify) — `SAMPLES`/`REFINE_ROUNDS`
 * are picked so the returned `t` lands within better than 1e-4 of the true
 * minimum for curves at typical document scale, giving projection error well
 * under the story's 0.5 doc-px acceptance bound (see bezier.test.ts).
 *
 * Returns the parameter `t`, the point itself, and the (non-squared)
 * distance — callers compare distances across segments to find the closest
 * segment in a whole path (`pathEdit.ts::closestPointOnPath`).
 */
export interface ClosestPointResult {
  t: number;
  point: Point2D;
  distance: number;
}

const SAMPLES = 32;
const REFINE_ROUNDS = 24;

export function closestPointOnCubic(cubic: Cubic, point: Point2D): ClosestPointResult {
  let bestT = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const d = distSq(cubicPointAt(cubic, t), point);
    if (d < bestDistSq) {
      bestDistSq = d;
      bestT = t;
    }
  }

  // Ternary-search refine in a shrinking window around the best sample —
  // valid because distance-to-point along a short bracket of a smooth curve
  // is unimodal in practice for the window widths used here.
  let lo = Math.max(0, bestT - 1 / SAMPLES);
  let hi = Math.min(1, bestT + 1 / SAMPLES);
  for (let i = 0; i < REFINE_ROUNDS; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const d1 = distSq(cubicPointAt(cubic, m1), point);
    const d2 = distSq(cubicPointAt(cubic, m2), point);
    if (d1 < d2) {
      hi = m2;
    } else {
      lo = m1;
    }
  }
  const t = (lo + hi) / 2;
  const p = cubicPointAt(cubic, t);
  return { t, point: p, distance: Math.sqrt(distSq(p, point)) };
}

/**
 * Straight-segment convenience for hit-testing/insertion maths: control
 * points at the 1/3 and 2/3 marks give a cubic that parametrises the segment
 * *linearly* (constant speed) — pinning both control points to the endpoints
 * (`p0, p0, p1, p1`) is also a degenerate cubic tracing the same straight
 * line, but its `t` is NOT proportional to arc length (it eases in/out), so
 * `cubicPointAt(lineCubic(...), t)` would not equal `lerp(from, to, t)`. The
 * corner-segment *rendering* convention in `vectorRasterize.ts::segmentCommand`
 * still emits a plain `lineTo` — this is purely an editing-time helper.
 */
export function lineCubic(from: Point2D, to: Point2D): Cubic {
  return {
    p0: from,
    c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
    c2: { x: from.x + (2 * (to.x - from.x)) / 3, y: from.y + (2 * (to.y - from.y)) / 3 },
    p1: to,
  };
}
