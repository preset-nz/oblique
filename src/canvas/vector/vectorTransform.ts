import type { AnchorPoint, Transform2D, VectorPath } from '@/scene/types';
import type { Point } from '../transform2d';

/**
 * Pure helpers for mapping a `VectorNode`'s path geometry (always stored in
 * the node's own untransformed/local space, `transform2d.ts`'s `Point`
 * space) through its `transform2d`, so `PathEditor.tsx`'s overlay renders
 * where the shape actually paints (bug fix, 2026-07-05: the overlay used to
 * render at raw path coordinates, ignoring `transform2d`). Kept separate
 * from `PathEditor.tsx` so the mapping is unit-testable without mounting a
 * component, matching `pathEdit.ts`'s "hard maths lives outside React"
 * convention.
 */

/** Maps one anchor's point/handles through `fn` (e.g. `localToWorld`/`worldToLocal`). */
export function mapAnchor(anchor: AnchorPoint, fn: (p: Point) => Point): AnchorPoint {
  return {
    point: fn(anchor.point),
    handleIn: anchor.handleIn ? fn(anchor.handleIn) : undefined,
    handleOut: anchor.handleOut ? fn(anchor.handleOut) : undefined,
  };
}

/** Maps every anchor of every path through `fn` — `closed` and array shape are preserved. */
export function mapVectorPaths(paths: VectorPath[], fn: (p: Point) => Point): VectorPath[] {
  return paths.map((path) => ({ ...path, anchors: path.anchors.map((a) => mapAnchor(a, fn)) }));
}

/**
 * Converts a document/screen-space distance threshold (e.g. "6 screen px,
 * already converted to document px via `viewScale`") into the equivalent
 * threshold in the node's local/path space, so a hit-test done against
 * local-space geometry (`closestPointOnPaths`, which operates on
 * `node.paths` directly) stays perceptually the same size on screen
 * regardless of the node's `transform2d` scale.
 *
 * A single scalar can't invert a non-uniform (scaleX != scaleY) scale
 * exactly — the true local-space threshold is direction-dependent. This
 * picks the *larger* axis magnitude (the more forgiving choice: it never
 * shrinks the click target below what a uniform-scale node would get),
 * matching the "max axis" option flagged in the story brief.
 */
export function localDistanceThreshold(docThreshold: number, t: Transform2D): number {
  const maxScale = Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 1e-6);
  return docThreshold / maxScale;
}
