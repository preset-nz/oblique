import type { MaskDef, MaskShape, Transform2D, VectorMaskRef, VectorPath } from './types';
import { buildPath2D, pathCommandsFor } from './vectorRasterize';

/**
 * Mask rasterisation (selection-to-mask.md §Model): a `MaskDef`'s document-
 * space shape becomes a single-channel byte plane (1 byte/px, 0..255) at the
 * cook target size. The bitmap is derived state — rebuilt per cook level,
 * never persisted.
 *
 * Split like `cook.ts`'s downscale: the pure maths (`docToLocalMatrix`,
 * `boxBlurMask`, `invertMask`) are unit-tested here; the OffscreenCanvas
 * composition (`rasterizeMask`) is a thin production-only wrapper injected
 * through `CookDeps.rasterizeMask` so cook tests never need a canvas.
 *
 * Coordinate mapping: the shape is drawn in document space, but the cook
 * buffer is the node's own source pixels. `MaskDef.appliedTransform2d` (the
 * node's transform snapshot at apply time) maps document → node-local via
 * the inverse of `canvas/transform2d.ts`'s `localToWorld` — reimplemented
 * here as a flat 2D matrix because `scene/` must not import `canvas/`
 * (depcruise). `canvas/transform2d.test.ts` cross-checks the two stay
 * inverses of each other.
 *
 * `rasterizeVectorMask` (vector-modifier-masks.md) is this module's second
 * rasteriser: same `docToLocalMatrix` + feather/expand/invert pipeline, fed
 * a `Path2D` built from a VectorNode's live `paths`
 * (`vectorRasterize.ts`'s `pathCommandsFor`/`buildPath2D`) instead of a
 * baked `MaskShape` — the coordinate mapping is identical (document space
 * -> the CONSUMING node's local buffer via its own `appliedTransform2d`
 * snapshot), only the shape source differs.
 */

/** Column-major 2D affine matrix, `[a, b, c, d, e, f]` as `ctx.setTransform` takes it. */
export type Matrix2D = [number, number, number, number, number, number];

/**
 * Document-space → node-local matrix for a node with transform `t` and
 * source extent `w`×`h` — the inverse of localToWorld's
 * `world = centre + R(rotation)·S(scale)·(local - localCentre)`:
 * `local = S⁻¹·R⁻¹·(world - centre) + localCentre`.
 */
export function docToLocalMatrix(t: Transform2D, w: number, h: number): Matrix2D {
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const sx = t.scaleX === 0 ? 0 : 1 / t.scaleX;
  const sy = t.scaleY === 0 ? 0 : 1 / t.scaleY;
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;

  // Row 1 of S⁻¹·R⁻¹ is (cos, sin)/scaleX; row 2 is (-sin, cos)/scaleY.
  const a = cos * sx;
  const c = sin * sx;
  const b = -sin * sy;
  const d = cos * sy;
  const e = w / 2 - (a * cx + c * cy);
  const f = h / 2 - (b * cx + d * cy);
  return [a, b, c, d, e, f];
}

/**
 * Forward companion of `docToLocalMatrix`: a node's placement matrix —
 * authored/local space -> composited document space (scale/rotate about the
 * raster centre `(t.x + w/2, t.y + h/2)`, matching the compositor's
 * `withNodeTransform` convention). Exact algebraic inverse of
 * `docToLocalMatrix` for the same `(t, w, h)`.
 */
export function localToDocMatrix(t: Transform2D, w: number, h: number): Matrix2D {
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;

  const a = cos * t.scaleX;
  const b = sin * t.scaleX;
  const c = -sin * t.scaleY;
  const d = cos * t.scaleY;
  const e = cx - (a * (w / 2) + c * (h / 2));
  const f = cy - (b * (w / 2) + d * (h / 2));
  return [a, b, c, d, e, f];
}

/** Apply a `Matrix2D` to a point — test helper and lasso pre-transform. */
export function applyMatrix(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * In-place three-pass box blur approximating a gaussian of sigma ≈ radius/2
 * (Kovesi's classic approximation) on a single-channel plane. Chosen over
 * `ctx.filter = 'blur(...)'` because canvas filters are unevenly supported
 * in WKWebView, and over a true gaussian because three box passes are
 * indistinguishable for a feather. Each pass is a running-sum sliding
 * window, O(px) regardless of radius. Radius is in target-resolution px
 * (the caller scales featherPx by the cook factor first).
 */
export function boxBlurMask(data: Uint8Array, width: number, height: number, radius: number): void {
  const r = Math.round(radius);
  if (r < 1) return;
  const boxes = boxSizesForGaussian(r, 3);
  const scratch = new Float32Array(data.length);
  const plane = Float32Array.from(data);
  for (const size of boxes) {
    boxBlurPass(plane, scratch, width, height, (size - 1) / 2);
  }
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.max(0, Math.min(255, Math.round(plane[i])));
  }
}

/** Standard box-size derivation for approximating a gaussian with `n` box passes. */
function boxSizesForGaussian(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** One horizontal + one vertical running-sum box pass with edge clamping. */
function boxBlurPass(
  plane: Float32Array,
  scratch: Float32Array,
  width: number,
  height: number,
  r: number,
): void {
  const rr = Math.max(0, Math.round(r));
  const norm = 1 / (2 * rr + 1);

  // Horizontal: plane -> scratch.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -rr; x <= rr; x++) sum += plane[row + clamp(x, width)];
    for (let x = 0; x < width; x++) {
      scratch[row + x] = sum * norm;
      sum += plane[row + clamp(x + rr + 1, width)] - plane[row + clamp(x - rr, width)];
    }
  }

  // Vertical: scratch -> plane.
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -rr; y <= rr; y++) sum += scratch[clamp(y, height) * width + x];
    for (let y = 0; y < height; y++) {
      plane[y * width + x] = sum * norm;
      sum +=
        scratch[clamp(y + rr + 1, height) * width + x] - scratch[clamp(y - rr, height) * width + x];
    }
  }
}

function clamp(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** In-place `255 - v` — the mask's `invert` flag, applied after feathering. */
export function invertMask(data: Uint8Array): void {
  for (let i = 0; i < data.length; i++) data[i] = 255 - data[i];
}

function shapePath(shape: MaskShape): Path2D {
  const path = new Path2D();
  switch (shape.kind) {
    case 'rect':
      path.rect(shape.rect.x, shape.rect.y, shape.rect.w, shape.rect.h);
      break;
    case 'ellipse':
      path.ellipse(
        shape.rect.x + shape.rect.w / 2,
        shape.rect.y + shape.rect.h / 2,
        shape.rect.w / 2,
        shape.rect.h / 2,
        0,
        0,
        Math.PI * 2,
      );
      break;
    case 'lasso': {
      const [first, ...rest] = shape.points;
      path.moveTo(first.x, first.y);
      for (const p of rest) path.lineTo(p.x, p.y);
      path.closePath();
      break;
    }
  }
  return path;
}

/**
 * Fill (and, if non-zero, expand/contract-stroke) `path` into a fresh
 * OffscreenCanvas already `setTransform`'d by the caller, then read back the
 * alpha channel as a single-channel plane. The one piece of canvas work
 * `rasterizeMask` (baked shapes) and `rasterizeVectorMask` (live vector
 * references) share — everything upstream (which transform, which fill
 * rule) and downstream (feather, invert) differs per caller or is applied
 * by them directly via `boxBlurMask`/`invertMask`.
 *
 * Expand/contract is a stroke-based offset: expanding strokes the path
 * boundary in fill colour (width 2×expand ≈ dilate by expand px), contracting
 * knocks the boundary band out with destination-out (≈ erode). Simplest
 * honest offset — exact polygon offsetting is not worth its dependency for a
 * feathered selection edge.
 */
function fillAndReadPlane(
  ctx: OffscreenCanvasRenderingContext2D,
  path: Path2D,
  fillRule: CanvasFillRule,
  expand: number,
  width: number,
  height: number,
): Uint8Array {
  ctx.fillStyle = '#fff';
  ctx.fill(path, fillRule);

  if (expand !== 0) {
    ctx.lineWidth = Math.abs(expand) * 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    if (expand < 0) ctx.globalCompositeOperation = 'destination-out';
    ctx.stroke(path);
    ctx.globalCompositeOperation = 'source-over';
  }

  const image = ctx.getImageData(0, 0, width, height);
  const plane = new Uint8Array(width * height);
  for (let i = 0; i < plane.length; i++) plane[i] = image.data[i * 4 + 3];
  return plane;
}

/**
 * Rasterise `mask` for a node with source extent `sourceSize`, at the cook
 * target `width`×`height` (= sourceSize × factor). Production-only (needs
 * OffscreenCanvas/Path2D) — cook tests inject a fake via `CookDeps`.
 */
export function rasterizeMask(
  mask: MaskDef,
  sourceSize: [number, number],
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  // Document space -> node-local (via the apply-time transform snapshot),
  // then node-local -> target px (cook factor).
  const m = docToLocalMatrix(mask.appliedTransform2d, sourceSize[0], sourceSize[1]);
  ctx.setTransform(factor, 0, 0, factor, 0, 0);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);

  const path = shapePath(mask.shape);
  const plane = fillAndReadPlane(ctx, path, 'nonzero', mask.expand, width, height);

  const featherRadius = mask.featherPx * factor;
  if (featherRadius >= 0.5) boxBlurMask(plane, width, height, featherRadius);
  if (mask.invert) invertMask(plane);
  return plane;
}

/**
 * Rasterise a *live* vector-referenced mask (vector-modifier-masks.md): the
 * shape comes from a VectorNode's current `paths`/`fillRule` (authored in
 * document space), the feather/expand/invert come from the `ref` (the
 * per-modifier reference, not the node — the story's explicit split, so the
 * same node can be soft on one modifier and hard-inverted on another).
 *
 * `consumerSourceSize`/`consumerTransform2d` map document space into the
 * CONSUMING node's own local buffer — like `rasterizeMask`'s
 * `sourceSize`/`mask.appliedTransform2d`, except the transform is the
 * consumer's CURRENT one, passed fresh each cook, never a snapshot: vector
 * masks are document-pinned (VectorMaskRef's doc comment; Georg 2026-07-06)
 * — the mask reads where the shape sits in the document, and moving the
 * consumer recooks it in its new frame. A vector node's paths are
 * document-space, but the modifier being masked cooks into its own node-
 * local buffer (node-transform-2d.md: a node's raster is always produced
 * untransformed at its own origin). Production-only, same shape as
 * `rasterizeMask` — injected via `CookDeps.rasterizeVectorMask`.
 *
 * The referenced VectorNode's OWN `transform2d` IS applied (`vectorTransform2d`
 * + `documentSize`, its raster frame): the Move tool transforms vector nodes
 * like any node (dogfood 2026-07-06 — a moved shape painted in its new place
 * but masked from its authored one), so the mask must read the shape's
 * COMPOSITED position: path local space -> document via the vector's
 * placement (`localToDocMatrix`, centre-of-document-raster convention,
 * matching the compositor and PathEditor), then document -> consumer-local.
 * Both transforms are read fresh each cook — document-pinned means pinned
 * to where the shape *shows*, not to any snapshot.
 */
export function rasterizeVectorMask(
  paths: VectorPath[],
  fillRule: 'nonzero' | 'evenodd',
  ref: Pick<VectorMaskRef, 'featherPx' | 'expand' | 'invert'>,
  vectorTransform2d: Transform2D,
  documentSize: [number, number],
  consumerTransform2d: Transform2D,
  consumerSourceSize: [number, number],
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  // Path-local -> composited document (the vector node's own placement;
  // vector rasters span documentSize, vector-node-model.md's Sizing note),
  // then document -> consuming-node-local (the consumer's CURRENT
  // transform — document-pinned), then node-local -> target px (cook
  // factor). ctx.transform appends right, so the calls run in reverse
  // application order.
  const m = docToLocalMatrix(consumerTransform2d, consumerSourceSize[0], consumerSourceSize[1]);
  const vm = localToDocMatrix(vectorTransform2d, documentSize[0], documentSize[1]);
  ctx.setTransform(factor, 0, 0, factor, 0, 0);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.transform(vm[0], vm[1], vm[2], vm[3], vm[4], vm[5]);

  const path = buildPath2D(pathCommandsFor(paths));
  const plane = fillAndReadPlane(ctx, path, fillRule, ref.expand, width, height);

  const featherRadius = ref.featherPx * factor;
  if (featherRadius >= 0.5) boxBlurMask(plane, width, height, featherRadius);
  if (ref.invert) invertMask(plane);
  return plane;
}
