import type { Point2D, VectorPath } from './types';

/**
 * Tight document-space bounding box of a vector node's paths (epic 06
 * README §Decisions, "vector content bounds"): the raster deliberately
 * spans the whole document (vectorRasterize.ts), so anything that should
 * hug the drawn shape — hit-testing, a future transform box, the
 * compositor's rotate/scale pivot — asks this module instead of the raster
 * size. Tight means true curve extrema (cubic derivative roots), not the
 * control-point hull, so a handle dragged far out doesn't inflate the box
 * beyond where the curve actually goes.
 *
 * Lives in `src/scene/` (not beside `canvas/vector/bezier.ts`) because the
 * compositor is a legitimate consumer and may not import from
 * `src/canvas/` — the small cubic-evaluation overlap with bezier.ts is the
 * price of the layer boundary.
 */

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One cubic axis value at t. */
function cubicAxis(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Interior extrema parameters of one cubic axis: roots of the quadratic
 * derivative, kept to the open interval (0, 1) — the endpoints are always
 * sampled anyway.
 */
function cubicExtremaTs(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) = 3(at² + bt + c) with:
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

class BoundsAccumulator {
  minX = Number.POSITIVE_INFINITY;
  minY = Number.POSITIVE_INFINITY;
  maxX = Number.NEGATIVE_INFINITY;
  maxY = Number.NEGATIVE_INFINITY;

  addX(v: number): void {
    if (v < this.minX) this.minX = v;
    if (v > this.maxX) this.maxX = v;
  }

  addY(v: number): void {
    if (v < this.minY) this.minY = v;
    if (v > this.maxY) this.maxY = v;
  }

  addPoint(p: Point2D): void {
    this.addX(p.x);
    this.addY(p.y);
  }

  /** Endpoints plus interior extrema of one cubic segment, per axis. */
  addCubic(from: Point2D, c1: Point2D, c2: Point2D, to: Point2D): void {
    this.addPoint(from);
    this.addPoint(to);
    for (const t of cubicExtremaTs(from.x, c1.x, c2.x, to.x)) {
      this.addX(cubicAxis(from.x, c1.x, c2.x, to.x, t));
    }
    for (const t of cubicExtremaTs(from.y, c1.y, c2.y, to.y)) {
      this.addY(cubicAxis(from.y, c1.y, c2.y, to.y, t));
    }
  }

  toBounds(): Bounds | null {
    if (this.minX > this.maxX || this.minY > this.maxY) return null;
    return {
      x: this.minX,
      y: this.minY,
      w: this.maxX - this.minX,
      h: this.maxY - this.minY,
    };
  }
}

/**
 * Tight bbox of `paths`, or `null` for no anchors at all. Mirrors
 * vectorRasterize.ts's segment rules: corner-to-corner segments are
 * straight lines (endpoints suffice); any handle makes the segment a cubic
 * (missing handles pin to the segment's own endpoints, same as
 * `segmentCommand`); a closed path adds the wrap-around segment.
 */
export function vectorContentBounds(paths: VectorPath[]): Bounds | null {
  const acc = new BoundsAccumulator();
  for (const path of paths) {
    const { anchors, closed } = path;
    if (anchors.length === 1) acc.addPoint(anchors[0].point);
    const last = anchors.length;
    const segments = closed && anchors.length > 1 ? last : last - 1;
    for (let i = 0; i < segments; i++) {
      const from = anchors[i];
      const to = anchors[(i + 1) % last];
      if (!from.handleOut && !to.handleIn) {
        acc.addPoint(from.point);
        acc.addPoint(to.point);
      } else {
        acc.addCubic(from.point, from.handleOut ?? from.point, to.handleIn ?? to.point, to.point);
      }
    }
  }
  return acc.toBounds();
}
