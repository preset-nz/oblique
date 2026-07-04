import * as cache from '@/scene/cache';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { SceneNode } from '@/scene/types';

const CHECKER_SQUARE_PX = 16;
const CHECKER_LIGHT = '#3a3a3a';
const CHECKER_DARK = '#2a2a2a';
const STRIPE_BG = '#3a2a1a';
const STRIPE_FG = '#f59e0b';

/**
 * Interim single-node paint (cook-pipeline.md — replaced by the full
 * bottom-up compositor in Epic 03). Picks the topmost visible `image`-output
 * node; `scene.nodes[0]` is the top of the stack.
 */
export function findTopmostImageNode(nodes: SceneNode[]): SceneNode | undefined {
  return nodes.find((n) => n.visible && n.output === 'image');
}

/** Best available cache for a node: WORKING if cooked, else DRAFT. */
export function pickBestCache(nodeId: string): ImageBitmap | undefined {
  return cache.get(nodeId, 'working') ?? cache.get(nodeId, 'draft');
}

/**
 * Per-context pattern cache: a 2x2-square tile built once on an
 * `OffscreenCanvas` and repeated via `createPattern`, rather than a
 * fillRect-per-square loop. At a 24 MP document that loop is ~94,000
 * `fillRect` calls *every paint* (paintScene runs on every cacheVersion
 * bump, i.e. every draft cook during a scrub) — plausibly the dominant
 * cost against the "DRAFT loop >= 20fps" acceptance. One `createPattern` +
 * one `fillRect` scales with document area at a fraction of that cost, and
 * still draws in document space so it scales correctly with zoom.
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

/** Diagonal-stripe placeholder for a pixel node whose source file couldn't be re-decoded on load. */
function drawStripedPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.fillStyle = STRIPE_BG;
  ctx.fillRect(0, 0, w, h);

  const stripeWidth = Math.max(8, Math.round(Math.min(w, h) / 40));
  ctx.strokeStyle = STRIPE_FG;
  ctx.lineWidth = stripeWidth;
  const diagonal = w + h;
  for (let x = -h; x < diagonal; x += stripeWidth * 2) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h, h);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Paint the document: checkerboard behind transparency, then the topmost
 * visible image node's best-available cache scaled to document size.
 * `ctx` is expected to already carry the document->screen view transform
 * (see `Viewport.tsx`); this function draws purely in document space.
 */
export function paintScene(ctx: CanvasRenderingContext2D, docW: number, docH: number): void {
  if (docW <= 0 || docH <= 0) return;

  drawCheckerboard(ctx, docW, docH);

  const node = findTopmostImageNode(useSceneStore.getState().scene.nodes);
  if (!node) return;

  if (sources.isSourceMissing(node.id)) {
    drawStripedPlaceholder(ctx, docW, docH);
    return;
  }

  const bitmap = pickBestCache(node.id);
  if (!bitmap) return; // still cooking (or not yet imported) — nothing to draw yet

  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = node.opacity;
  ctx.drawImage(bitmap, 0, 0, docW, docH);
  ctx.globalAlpha = 1;
}
