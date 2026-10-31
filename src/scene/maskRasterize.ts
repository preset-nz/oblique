import type { PixelMaskRef, Transform2D, VectorMaskRef, VectorPath } from './types';
import { buildPath2D, pathCommandsFor } from './vectorRasterize';

/**
 * Mask rasterisation (vector-modifier-masks.md): a `VectorMaskRef`'s live
 * shape becomes a single-channel byte plane (1 byte/px, 0..255) at the
 * cook target size. The bitmap is derived state — rebuilt per cook level,
 * never persisted.
 *
 * Split like `cook.ts`'s downscale: the pure maths (`docToLocalMatrix`,
 * `boxBlurMask`, `invertMask`) are unit-tested here; the OffscreenCanvas
 * composition (`rasterizeVectorMask`) is a thin production-only wrapper
 * injected through `CookDeps.rasterizeVectorMask` so cook tests never need
 * a canvas.
 *
 * Coordinate mapping: the shape is authored in document space, but the cook
 * buffer is the consuming node's own source pixels. The consumer's current
 * `transform2d` maps document → node-local via the inverse of
 * `canvas/transform2d.ts`'s `localToWorld` — reimplemented here as a flat
 * 2D matrix because `scene/` must not import `canvas/` (depcruise).
 * `canvas/transform2d.test.ts` cross-checks the two stay inverses of each
 * other.
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
 * In-place three-pass box blur approximating a gaussian of sigma ≈ radius
 * (Kovesi's classic approximation, fed `radius` as its sigma; measured at
 * 0.96-0.99 × radius for radius 4-30) on a single-channel plane. Chosen over
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

/**
 * Fill (and, if non-zero, expand/contract-stroke) `path` into a fresh
 * OffscreenCanvas already `setTransform`'d by the caller, then read back the
 * alpha channel as a single-channel plane. The one piece of canvas work
 * `rasterizeVectorMask` needs — everything upstream (which transform, which
 * fill rule) and downstream (feather, invert) is applied by the caller
 * directly via `boxBlurMask`/`invertMask`.
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
 * Rasterise a *live* vector-referenced mask (vector-modifier-masks.md): the
 * shape comes from a VectorNode's current `paths`/`fillRule` (authored in
 * document space), the feather/expand/invert come from the `ref` (the
 * per-modifier reference, not the node — the story's explicit split, so the
 * same node can be soft on one modifier and hard-inverted on another).
 *
 * `consumerSourceSize`/`consumerTransform2d` map document space into the
 * CONSUMING node's own local buffer. For a document-pinned ref (the default,
 * `space` absent or `'document'`) the transform is the consumer's CURRENT
 * one, passed fresh each cook: the mask reads where the shape sits in the
 * document, and moving the consumer recooks it in its new frame (Georg
 * 2026-07-06). For `space: 'node'` (mask-follows-node.md) the ref's
 * `attachTransform` snapshot is inverted INSTEAD, so the mask lands in the
 * same place in the consumer's local buffer wherever the consumer later
 * moves — it travels with the pixels. A vector node's paths are document-space,
 * but the modifier being masked cooks into its own node-local buffer
 * (node-transform-2d.md: a node's raster is always produced untransformed
 * at its own origin). Production-only (needs OffscreenCanvas/Path2D) —
 * injected via `CookDeps.rasterizeVectorMask` so cook tests never need a
 * canvas.
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
  ref: Pick<VectorMaskRef, 'featherPx' | 'expand' | 'invert' | 'space' | 'attachTransform'>,
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
  const consumerFrame =
    ref.space === 'node' && ref.attachTransform ? ref.attachTransform : consumerTransform2d;
  const m = docToLocalMatrix(consumerFrame, consumerSourceSize[0], consumerSourceSize[1]);
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

// ---------------------------------------------------------------- pixel drivers

/** `m1 ∘ m2`: the matrix that applies `m2` first, then `m1`. */
export function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Driver-local px (its source extent) -> the consumer's cook buffer px (layer-as-driver.md
 * §Space): the driver's placement into the document, then the document into the consumer's
 * local frame (its CURRENT transform: a pixel driver is always document-space), then the cook
 * factor. The driver's raster is drawn at its source extent whatever its cooked size, so the
 * cook-level rounding and a locked driver's full-size bake both land in the same place.
 */
export function driverToTargetMatrix(
  driverTransform2d: Transform2D,
  driverSourceSize: [number, number],
  consumerTransform2d: Transform2D,
  consumerSourceSize: [number, number],
  factor: number,
): Matrix2D {
  const toDoc = localToDocMatrix(driverTransform2d, driverSourceSize[0], driverSourceSize[1]);
  const toConsumer = docToLocalMatrix(
    consumerTransform2d,
    consumerSourceSize[0],
    consumerSourceSize[1],
  );
  return multiplyMatrix([factor, 0, 0, factor, 0, 0], multiplyMatrix(toConsumer, toDoc));
}

/** Rec. 709 luma weights: `sidecar/ops/__init__.py`'s `LUMA_*709`, the ones `desaturate` uses. */
const LUMA_R709 = 0.2126;
const LUMA_G709 = 0.7152;
const LUMA_B709 = 0.0722;

/**
 * A driver's sampled RGBA8 pixels -> the single-channel mask plane (1 byte/px) the sidecar
 * blends by (selection-to-mask.md). Pure, so the maths is tested without a canvas.
 *
 * - `luminance`: Rec. 709 on the stored sRGB bytes, as `desaturate` reads them (no
 *   linearising), times alpha, so a transparent pixel (outside the driver, or cut away) reads
 *   as black rather than as whatever colour it hides.
 * - `alpha`: the alpha channel.
 * - Levels: `low` maps to 0 and `high` to 1, linear between, clamped. `high < low` runs the
 *   ramp backwards; `high === low` is a hard step at that level.
 * - `invert` flips the result, after the levels.
 */
export function pixelMaskPlane(
  rgba: Uint8Array | Uint8ClampedArray,
  ref: Pick<PixelMaskRef, 'channel' | 'low' | 'high' | 'invert'>,
): Uint8Array {
  const n = rgba.length >> 2;
  const plane = new Uint8Array(n);
  const span = ref.high - ref.low;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const alpha = rgba[o + 3] / 255;
    const v =
      ref.channel === 'alpha'
        ? alpha
        : ((LUMA_R709 * rgba[o] + LUMA_G709 * rgba[o + 1] + LUMA_B709 * rgba[o + 2]) / 255) * alpha;
    let t = span === 0 ? (v >= ref.low ? 1 : 0) : (v - ref.low) / span;
    t = Math.max(0, Math.min(1, t));
    if (ref.invert) t = 1 - t;
    plane[i] = Math.round(t * 255);
  }
  return plane;
}

/**
 * Rasterise a pixel-driven mask (layer-as-driver.md): draw the driver's cooked raster into the
 * consumer's cook buffer through `driverToTargetMatrix`, read it back and turn it into the
 * plane (`pixelMaskPlane`). `raster` absent (the driver hasn't cooked, or has no source)
 * samples as fully transparent, the same as outside the driver's footprint. Production-only
 * (needs OffscreenCanvas); injected through `CookDeps.rasterizePixelMask`, like the vector one.
 */
export function rasterizePixelMask(
  raster: ImageBitmap | undefined,
  ref: Pick<PixelMaskRef, 'channel' | 'low' | 'high' | 'invert'>,
  driverTransform2d: Transform2D,
  driverSourceSize: [number, number],
  consumerTransform2d: Transform2D,
  consumerSourceSize: [number, number],
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  if (!raster) return pixelMaskPlane(new Uint8Array(width * height * 4), ref);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  const m = driverToTargetMatrix(
    driverTransform2d,
    driverSourceSize,
    consumerTransform2d,
    consumerSourceSize,
    factor,
  );
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(raster, 0, 0, driverSourceSize[0], driverSourceSize[1]);
  return pixelMaskPlane(ctx.getImageData(0, 0, width, height).data, ref);
}
