import * as cache from '@/scene/cache';
import * as sources from '@/scene/sources';
import type { Resolution, Scene, SceneNode } from '@/scene/types';
import { isPixelNode } from '@/scene/types';
import { mapBlendMode } from './blend';

/** The subset of the Canvas 2D API the compositor needs — satisfied by both
 * `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D`. */
export type Composite2DContext = Pick<
  CanvasRenderingContext2D,
  | 'drawImage'
  | 'globalAlpha'
  | 'globalCompositeOperation'
  | 'imageSmoothingEnabled'
  | 'save'
  | 'restore'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'fillStyle'
  | 'fillRect'
  | 'strokeStyle'
  | 'lineWidth'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
>;

const STRIPE_BG = '#3a2a1a';
const STRIPE_FG = '#f59e0b';

/** Best-to-worst cache order: baked (full res) > working > draft. */
const LEVEL_ORDER: Resolution[] = ['baked', 'working', 'draft'];

const LEVEL_FACTOR: Record<Resolution, number> = {
  baked: 1,
  working: 1 / 2,
  draft: 1 / 8,
};

/** Downscale factor for a resolution level, relative to a node's own `sourceSize`. */
export function resolutionFactorFor(level: Resolution): number {
  return LEVEL_FACTOR[level];
}

export interface BestCache {
  bitmap: ImageBitmap;
  level: Resolution;
}

/**
 * Cache lookup, injectable so export (project/export.ts) can point the
 * exact same composite routine at a local map of one-shot full-res bitmaps
 * instead of the shared scene/cache module — export never writes the
 * `baked` cache slot (locking semantics are Epic 07's), so it can't reuse
 * `cache.get` as-is. Defaults to the real module for every normal caller.
 */
export type CacheLookup = (nodeId: string, level: Resolution) => ImageBitmap | undefined;

/**
 * Best available cache for a node at or below `level` — requested level,
 * else next-lower available, cascading down to draft, else `undefined`
 * (draws nothing rather than blocking; architecture.md §Compositor step 3).
 */
export function pickBestAvailable(
  nodeId: string,
  level: Resolution,
  getCache: CacheLookup = cache.get,
): BestCache | undefined {
  const startIndex = LEVEL_ORDER.indexOf(level);
  for (let i = startIndex; i < LEVEL_ORDER.length; i++) {
    const candidateLevel = LEVEL_ORDER[i];
    const bitmap = getCache(nodeId, candidateLevel);
    if (bitmap) return { bitmap, level: candidateLevel };
  }
  return undefined;
}

/** Diagonal-stripe placeholder for a pixel node whose source file couldn't be re-decoded on load. */
function drawStripedPlaceholder(ctx: Composite2DContext, w: number, h: number): void {
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
 * Bottom-up node order for the walk: array index 0 is the top of the stack
 * (layer-panel order — scene/types.ts), so compositing paints last-first.
 */
function bottomUpOrder(nodes: SceneNode[]): SceneNode[] {
  return [...nodes].reverse();
}

/**
 * Split the bottom-up node order into mask-scoped spans. A span ends (and
 * the next begins) at every `output: 'mask'` node. Mask clipping itself is
 * Epic 06's job — today there are never any mask nodes, so this always
 * returns one span (the whole stack) — but the walk stays span-shaped so
 * the mask hook drops in without restructuring (architecture.md §Compositor,
 * "Mask scoping").
 */
export function splitIntoSpans(nodes: SceneNode[]): SceneNode[][] {
  const ordered = bottomUpOrder(nodes);
  const spans: SceneNode[][] = [];
  let current: SceneNode[] = [];
  for (const node of ordered) {
    current.push(node);
    if (node.output === 'mask') {
      spans.push(current);
      current = [];
    }
  }
  if (current.length > 0) spans.push(current);
  return spans;
}

/** Destination draw size for a node at `level`: its own `sourceSize`, scaled by the level's factor. */
export function destSizeFor(
  node: SceneNode,
  level: Resolution,
  documentSize: [number, number],
): [number, number] {
  const factor = resolutionFactorFor(level);
  // A vector node's raster always spans documentSize (vector-node-model.md's
  // Sizing note — no sourceSize of its own); mesh/splat nodes will get their
  // own source-size concept in Milestone B. Only PixelNode carries
  // sourceSize today.
  const [srcW, srcH] = isPixelNode(node) ? node.sourceSize : documentSize;
  return [srcW * factor, srcH * factor];
}

/**
 * Applies a node's `transform2d` around `ctx`'s current origin: translate by
 * (x, y) scaled to `level` (the whole buffer is level-scaled — see
 * `computeBufferSize` — so a document-space translation must scale with it
 * too, unlike scale/rotation which are level-invariant ratios/angles), then
 * rotate and scale around the node's own centre (`destW/2, destH/2`). One
 * `save()`/`restore()` pair brackets the node's whole draw call, whether or
 * not it actually carries a transform — always balanced, so the early
 * `continue`s below (missing source, no cache) never leak an unmatched
 * `save()`.
 */
function withNodeTransform(
  ctx: Composite2DContext,
  node: SceneNode,
  destW: number,
  destH: number,
  level: Resolution,
  draw: () => void,
): void {
  ctx.save();
  const t = node.transform2d;
  if (t) {
    const factor = resolutionFactorFor(level);
    const cx = destW / 2;
    const cy = destH / 2;
    ctx.translate(t.x * factor, t.y * factor);
    ctx.translate(cx, cy);
    ctx.rotate(t.rotation);
    ctx.scale(t.scaleX, t.scaleY);
    ctx.translate(-cx, -cy);
  }
  draw();
  ctx.restore();
}

function drawSpan(
  ctx: Composite2DContext,
  span: SceneNode[],
  level: Resolution,
  scene: Scene,
  getCache: CacheLookup,
): void {
  for (const node of span) {
    if (!node.visible || node.output !== 'image') continue;

    const [destW, destH] = destSizeFor(node, level, scene.documentSize);

    if (isPixelNode(node) && sources.isSourceMissing(node.id)) {
      // Diagnostic chrome, not scene content — always plain source-over/full-alpha.
      withNodeTransform(ctx, node, destW, destH, level, () => {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        drawStripedPlaceholder(ctx, destW, destH);
      });
      continue;
    }

    const best = pickBestAvailable(node.id, level, getCache);
    if (!best) continue; // still cooking (or not yet imported) — draws nothing, per spec

    withNodeTransform(ctx, node, destW, destH, level, () => {
      ctx.globalAlpha = node.opacity;
      ctx.globalCompositeOperation = mapBlendMode(node.blendMode);
      ctx.drawImage(best.bitmap, 0, 0, destW, destH);
    });
  }
}

let compositeCallCount = 0;

/** Number of times `compositeScene` has actually run — the dev recomposite counter. */
export function getCompositeCallCount(): number {
  return compositeCallCount;
}

/** Test-only: reset the recomposite counter between assertions. */
export function resetCompositeCallCount(): void {
  compositeCallCount = 0;
}

/**
 * Pure composite of (scene, cacheMap, level) onto `ctx`. Bottom-up walk,
 * skip invisible/non-image nodes, best-available-cache selection, each node
 * drawn at its own `sourceSize` (scaled to `level`) at document origin —
 * never stretched to `documentSize` (the multi-aspect-import distortion
 * bug this replaces). `ctx` is expected to already be document-space (no
 * view transform applied — that's the caller's blit concern); this
 * function never touches pan/zoom.
 *
 * `getCache` defaults to the real scene/cache module; export passes a
 * one-shot lookup over its own local bitmap map instead (see
 * project/export.ts) so this exact routine can run at full resolution
 * without ever writing the shared `baked` cache slot.
 */
export function compositeScene(
  ctx: Composite2DContext,
  scene: Scene,
  level: Resolution,
  getCache: CacheLookup = cache.get,
): void {
  compositeCallCount++;

  const [docW, docH] = scene.documentSize;
  if (docW <= 0 || docH <= 0) return;

  ctx.imageSmoothingEnabled = true;

  for (const span of splitIntoSpans(scene.nodes)) {
    drawSpan(ctx, span, level, scene, getCache);
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
