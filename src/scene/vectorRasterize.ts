import type { AnchorPoint, Point2D, VectorPath } from './types';

/**
 * Vector rasterisation (vector-node-model.md): a `VectorNode`'s `paths`
 * become its *source pixels* entering the normal cook path, the same role a
 * decoded file plays for `PixelNode` (architecture.md §Cook scheduler).
 * White fill on transparent — `output` decides image-vs-mask interpretation
 * later (mask-span-scoping.md); the raster itself never changes.
 *
 * Split like `maskRasterize.ts`: the pure path-command derivation
 * (`pathCommandsFor`) is unit-tested here — it's the only place this
 * module's own code could introduce non-determinism (Path2D fill itself is
 * deterministic by browser contract, so byte-identical output for identical
 * commands isn't this module's to prove). `rasterizeVector`, the
 * OffscreenCanvas/Path2D composition, is production-only and injected
 * through `CookDeps.rasterizeVector` (cook.ts) — cook tests stub it, never
 * need a canvas.
 */

/** One segment of a flattened path, in the order `Path2D` calls happen. */
export type PathCommand =
  | { op: 'moveTo'; to: Point2D }
  | { op: 'lineTo'; to: Point2D }
  | { op: 'bezierCurveTo'; c1: Point2D; c2: Point2D; to: Point2D }
  | { op: 'closePath' };

/**
 * A corner anchor (no `handleOut`/next anchor's `handleIn`) draws a straight
 * segment; drawing it as a degenerate cubic (control points pinned to the
 * segment's own endpoints) would be equivalent but `lineTo` says exactly
 * what's happening and matches `maskRasterize.ts`'s lasso convention.
 */
function segmentCommand(from: AnchorPoint, to: AnchorPoint): PathCommand {
  const c1 = from.handleOut ?? from.point;
  const c2 = to.handleIn ?? to.point;
  if (!from.handleOut && !to.handleIn) {
    return { op: 'lineTo', to: to.point };
  }
  return { op: 'bezierCurveTo', c1, c2, to: to.point };
}

/** One path's anchors -> ordered `Path2D` commands, honouring `closed`. */
function pathCommandsForOne(path: VectorPath): PathCommand[] {
  const { anchors, closed } = path;
  if (anchors.length === 0) return [];

  const commands: PathCommand[] = [{ op: 'moveTo', to: anchors[0].point }];
  for (let i = 1; i < anchors.length; i++) {
    commands.push(segmentCommand(anchors[i - 1], anchors[i]));
  }
  if (closed && anchors.length > 1) {
    commands.push(segmentCommand(anchors[anchors.length - 1], anchors[0]));
  }
  if (closed) {
    commands.push({ op: 'closePath' });
  }
  return commands;
}

/** All paths -> ordered `Path2D` commands, one flattened list (`moveTo` starts each contour). */
export function pathCommandsFor(paths: VectorPath[]): PathCommand[] {
  return paths.flatMap(pathCommandsForOne);
}

/**
 * Build a `Path2D` from pre-flattened commands — the only DOM-touching step
 * in the split. Exported so `maskRasterize.ts`'s vector-reference rasteriser
 * (vector-modifier-masks.md) can build the same `Path2D` a vector node's own
 * output raster uses, rather than re-deriving it.
 */
export function buildPath2D(commands: PathCommand[]): Path2D {
  const path = new Path2D();
  for (const cmd of commands) {
    switch (cmd.op) {
      case 'moveTo':
        path.moveTo(cmd.to.x, cmd.to.y);
        break;
      case 'lineTo':
        path.lineTo(cmd.to.x, cmd.to.y);
        break;
      case 'bezierCurveTo':
        path.bezierCurveTo(cmd.c1.x, cmd.c1.y, cmd.c2.x, cmd.c2.y, cmd.to.x, cmd.to.y);
        break;
      case 'closePath':
        path.closePath();
        break;
    }
  }
  return path;
}

/**
 * Rasterise `paths` at the cook target `width`×`height` (= documentSize ×
 * level factor — a vector node has no `sourceSize` of its own, its raster
 * always spans the document, vector-node-model.md's Sizing note),
 * `factor`-scaled so document-space coordinates land at the right target
 * pixels. Production-only (needs OffscreenCanvas/Path2D) — cook tests inject
 * a fake via `CookDeps.rasterizeVector`. Returns RGBA8 bytes (white fill,
 * alpha carries coverage) — same shape `CookDeps.downscale` returns, so the
 * vector cook branch slots into the same pipeline stage a pixel node's
 * decoded-source downscale would.
 */
export function rasterizeVector(
  paths: VectorPath[],
  fillRule: 'nonzero' | 'evenodd',
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  ctx.setTransform(factor, 0, 0, factor, 0, 0);
  const path2d = buildPath2D(pathCommandsFor(paths));
  ctx.fillStyle = '#fff';
  ctx.fill(path2d, fillRule);

  const image = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
}
