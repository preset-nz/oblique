import { compositeScene, resolutionFactorFor } from '@/compositor/composite';
import type { Resolution, Scene } from '@/scene/types';

const CHECKER_SQUARE_PX = 16;
const CHECKER_LIGHT = '#3a3a3a';
const CHECKER_DARK = '#2a2a2a';

/** On-screen composite target — the WORKING resolution (architecture.md §Compositor). */
export const DISPLAY_LEVEL: Resolution = 'working';

/**
 * Per-context pattern cache: a 2x2-square tile built once on an
 * `OffscreenCanvas` and repeated via `createPattern`, rather than a
 * fillRect-per-square loop. At a 24 MP document that loop is ~94,000
 * `fillRect` calls *every paint* — plausibly the dominant cost against the
 * "DRAFT loop >= 20fps" acceptance. One `createPattern` + one `fillRect`
 * scales with document area at a fraction of that cost, and still draws in
 * document space so it scales correctly with zoom.
 */
const checkerPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

function getCheckerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const cached = checkerPatterns.get(ctx);
  if (cached) return cached;
  if (typeof OffscreenCanvas === 'undefined') return null; // e.g. non-browser test environment

  const tileSize = CHECKER_SQUARE_PX * 2;
  const tile = new OffscreenCanvas(tileSize, tileSize);
  const tileCtx = tile.getContext('2d');
  if (!tileCtx) return null;

  tileCtx.fillStyle = CHECKER_LIGHT;
  tileCtx.fillRect(0, 0, tileSize, tileSize);
  tileCtx.fillStyle = CHECKER_DARK;
  tileCtx.fillRect(CHECKER_SQUARE_PX, 0, CHECKER_SQUARE_PX, CHECKER_SQUARE_PX);
  tileCtx.fillRect(0, CHECKER_SQUARE_PX, CHECKER_SQUARE_PX, CHECKER_SQUARE_PX);

  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) checkerPatterns.set(ctx, pattern);
  return pattern;
}

function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const pattern = getCheckerPattern(ctx);
  ctx.fillStyle = pattern ?? CHECKER_DARK; // flat fallback if pattern setup ever fails
  ctx.fillRect(0, 0, w, h);
}

/**
 * The `useViewTransformStore` half of the recompute-vs-reblit decision:
 * true only when the document's own dimensions changed, false for a pure
 * pan/zoom (`view.scale`/`tx`/`ty`) change. `Viewport.tsx`'s view-store
 * subscription calls this directly; the scene-store and cache-version
 * subscriptions always force a recompute unconditionally (any scene or
 * cache mutation is scene content, not a viewport concern) — this predicate
 * only needs to exist for the case that must NOT trigger one
 * (architecture.md §Compositor acceptance: "pan/zoom never triggers a
 * recomposite").
 */
export function viewChangeNeedsRecomposite(
  prev: { docW: number; docH: number },
  next: { docW: number; docH: number },
): boolean {
  return prev.docW !== next.docW || prev.docH !== next.docH;
}

/** Composite-buffer size at `level`: document size scaled by the level's factor, minimum 1px per side. */
export function computeBufferSize(docW: number, docH: number, level: Resolution): [number, number] {
  const factor = resolutionFactorFor(level);
  return [Math.max(1, Math.round(docW * factor)), Math.max(1, Math.round(docH * factor))];
}

/** Reuse `buffer` if it's already the right size, else allocate a new one. */
export function ensureBuffer(
  buffer: OffscreenCanvas | null,
  width: number,
  height: number,
): OffscreenCanvas {
  if (buffer && buffer.width === width && buffer.height === height) return buffer;
  return new OffscreenCanvas(width, height);
}

/** Rebuild `buffer`'s contents from the scene — the expensive, dirty-gated step. */
export function recompositeBuffer(buffer: OffscreenCanvas, scene: Scene, level: Resolution): void {
  const ctx = buffer.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, buffer.width, buffer.height);
  compositeScene(ctx, scene, level);
}

/**
 * Blit the composite buffer onto the visible canvas: checkerboard first (so
 * transparency in the composite shows through), then the buffer scaled up
 * to document size. `ctx` is expected to already carry the document->screen
 * view transform (see `Viewport.tsx`); this draws purely in document space
 * and never allocates — the cheap per-frame path pan/zoom drives.
 */
export function blitScene(
  ctx: CanvasRenderingContext2D,
  buffer: OffscreenCanvas | null,
  docW: number,
  docH: number,
): void {
  if (docW <= 0 || docH <= 0) return;

  drawCheckerboard(ctx, docW, docH);
  if (!buffer) return;

  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(buffer, 0, 0, docW, docH);
}
