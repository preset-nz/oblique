import * as cache from '@/scene/cache';
import * as sources from '@/scene/sources';
import type { Resolution, Scene, SceneNode } from '@/scene/types';
import { isPixelNode } from '@/scene/types';
import { mapBlendMode } from './blend';

/** The subset of the Canvas 2D API the compositor needs — satisfied by both
 * `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D`.
 * `canvas` is typed separately (not picked straight off
 * `CanvasRenderingContext2D`) because the two real contexts disagree on its
 * type (`HTMLCanvasElement` vs `OffscreenCanvas`) — `CanvasImageSource` is
 * the common supertype both actually satisfy, and it's exactly what
 * `drawImage` needs to read a context's own backing surface back as a
 * source (span-backdrop-blending.md's backdrop-seed step). */
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
> & { readonly canvas: CanvasImageSource };

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
 * "Is the bitmap cached at this node/level out of date with respect to the
 * node's current params?" — the node's own dirty flag, read at the
 * composite call site. Injected so the pure function stays testable and so
 * export (which composites nodes whose dirty flags are meaningless to it)
 * can opt out.
 */
export type StaleLookup = (nodeId: string, level: Resolution) => boolean;

/** Write order of a cached bitmap; higher is newer (see scene/cache.ts `getSeq`). */
export type SeqLookup = (nodeId: string, level: Resolution) => number | undefined;

/**
 * Best available cache for a node at or below `level` — requested level,
 * else next-lower available, cascading down to draft, else `undefined`
 * (draws nothing rather than blocking; architecture.md §Compositor step 3).
 *
 * Freshness beats resolution (architecture.md §Compositor step 3's staleness
 * clause). Without it a mid-scrub canvas is frozen: the node is dirty at
 * WORKING the moment a param moves, its WORKING bitmap goes stale, and the
 * 1/8-res DRAFT cooks that land every 80ms are never shown because the
 * cascade only ever walks *downward* from the requested level and stops at
 * the first hit. So:
 *
 * 1. Walk best-to-worst from `level`, return the first **non-stale** hit —
 *    with nothing dirty this is exactly the old cascade, and it keeps a
 *    freshly-cooked WORKING ahead of a DRAFT that happened to land after it
 *    (slow op, draft cook overtaken).
 * 2. All candidates stale (mid-scrub: draft re-dirtied a tick after it
 *    cooked): return the **most recently written** one. Highest-res would
 *    be wrong here — it's the pre-drag WORKING bitmap, and preferring it
 *    flickers the canvas back to the old image between draft cooks.
 */
export function pickBestAvailable(
  nodeId: string,
  level: Resolution,
  getCache: CacheLookup = cache.get,
  isStale: StaleLookup = () => false,
  getSeq: SeqLookup = cache.getSeq,
): BestCache | undefined {
  const startIndex = LEVEL_ORDER.indexOf(level);
  let newestStale: BestCache | undefined;
  let newestStaleSeq = -1;

  for (let i = startIndex; i < LEVEL_ORDER.length; i++) {
    const candidateLevel = LEVEL_ORDER[i];
    const bitmap = getCache(nodeId, candidateLevel);
    if (!bitmap) continue;
    if (!isStale(nodeId, candidateLevel)) return { bitmap, level: candidateLevel };

    // `?? -1` keeps an unknown seq (export's own bitmap map has none)
    // behind anything with a real one, and preserves level order among
    // several unknowns — the first, highest-res candidate wins the tie.
    const seq = getSeq(nodeId, candidateLevel) ?? -1;
    if (seq > newestStaleSeq) {
      newestStaleSeq = seq;
      newestStale = { bitmap, level: candidateLevel };
    }
  }
  return newestStale;
}

/**
 * The compositor's staleness source: a node's own dirty flags. BAKED is
 * never stale — it's only ever written by a lock and only ever cleared by
 * an unlock (architecture.md §Scene state), so it carries no dirty flag to
 * read.
 */
export function staleLookupFor(scene: Scene): StaleLookup {
  const nodeById = new Map(scene.nodes.map((n) => [n.id, n]));
  return (nodeId, level) => {
    if (level === 'baked') return false;
    return nodeById.get(nodeId)?.dirty[level] ?? false;
  };
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
 * the next begins) at every `output: 'mask'` node — the mask node is the
 * *last* element of the span it closes (mask-span-scoping.md). Implicit
 * boundaries only: the next mask node walking bottom-up, or the stack
 * bottom (a trailing non-mask-terminated span, or an empty stack).
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
  // A vector or text node's raster always spans documentSize (vector-node-model.md's
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

/**
 * Draws a plain (unmasked) run of nodes straight onto `ctx` — the body of
 * the old single-pass walk, unchanged; a masked span reuses it against a
 * scratch context instead of the main one (see `drawMaskedSpan`).
 */
function drawSpanContent(
  ctx: Composite2DContext,
  content: SceneNode[],
  level: Resolution,
  scene: Scene,
  getCache: CacheLookup,
  isStale: StaleLookup,
): void {
  for (const node of content) {
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

    // Locked nodes (lock-state-machine.md): request `baked` regardless of
    // the composite's own level — the existing best-available cascade
    // (baked -> working -> draft) covers the not-yet-rehydrated window
    // (fresh load / undo-into-locked, before the scheduler's rehydrate cook
    // lands). destW/destH stay sized to the composite's `level` so a locked
    // node's drawn size never mismatches its siblings.
    const requestLevel: Resolution = node.state === 'locked' ? 'baked' : level;
    const best = pickBestAvailable(node.id, requestLevel, getCache, isStale);
    if (!best) continue; // still cooking (or not yet imported) — draws nothing, per spec

    withNodeTransform(ctx, node, destW, destH, level, () => {
      ctx.globalAlpha = node.opacity;
      ctx.globalCompositeOperation = mapBlendMode(node.blendMode);
      ctx.drawImage(best.bitmap, 0, 0, destW, destH);
    });
  }
}

/**
 * A scratch surface to composite one masked span into before clipping it —
 * isolated from the main canvas so `destination-in` only ever erases *this
 * span's* pixels, never content already painted by an earlier (lower) span.
 * `canvas` is whatever `ctx` was carved from — passed straight to the main
 * context's `drawImage` once the span is clipped.
 */
export interface ScratchCanvas {
  ctx: Composite2DContext;
  canvas: CanvasImageSource;
}

export type CreateScratch = (width: number, height: number) => ScratchCanvas;

function realCreateScratch(width: number, height: number): ScratchCanvas {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  return { ctx, canvas };
}

/**
 * Composites `content` (everything since the previous mask boundary) into a
 * scratch canvas *seeded with the live backdrop* (everything already
 * composited onto `ctx` by earlier spans), clips the result to `maskNode`'s
 * own cooked raster via `destination-in`, then stamps it back onto the main
 * `ctx` (architecture.md §Compositor, "Mask scoping"; span-backdrop-
 * blending.md). `maskNode` itself is never drawn as content — its
 * `blendMode`/`opacity` are ignored (mask-span-scoping.md) and its raster
 * only ever supplies the clip's alpha.
 *
 * Seeding the scratch with the backdrop (rather than leaving it empty, as
 * before this fix) is what makes a span member's `blendMode`/`opacity` see
 * real pixels below the span, instead of transparency — a one-image span
 * with `multiply`/`screen` no longer silently renders as `normal`
 * (span-backdrop-blending.md's defect).
 *
 * Stamp-back operator sequence — the story's "one real problem": cut the
 * hole, then insert the blended plug.
 *
 *   1. `ctx` `destination-out` with the mask alpha (M): erases exactly the
 *      mask's coverage from the live backdrop. `main' = backdrop*(1-M)`.
 *   2. scratch `destination-in` with M (already applied for the clip):
 *      `scratch' = blended*M`, where `blended` = backdrop-seeded,
 *      content-composited scratch from step 1 above.
 *   3. `ctx` `lighter` (not `source-over`!) with the clipped scratch: pure
 *      premultiplied addition, `main'' = backdrop*(1-M) + blended*M`.
 *
 * That's the coverage-weighted lerp mask alpha is meant to express, done in
 * premultiplied space (where it's linear). `source-over` would be wrong
 * here: its own `(1 - srcAlpha)` factor would discount the just-cut hole a
 * *second* time by the clipped scratch's own alpha (`blended.alpha * M`),
 * under-counting backdrop alpha at partially-covered (feathered) pixels —
 * e.g. an opaque backdrop and opaque content at M=0.5 would land at
 * `main.alpha = 0.75` instead of `1`, a visible halo over a transparent
 * document background. `lighter` has no such discount, so it composes
 * exactly.
 *
 * Edge cases named in the story's acceptance:
 * - `content` empty (mask sits at the stack bottom, nothing below it since
 *   the previous boundary) — a no-op, not an error.
 * - `maskNode.visible === false` — a hidden mask stops clipping, same as any
 *   other hidden node stops contributing; its span draws unclipped.
 * - `maskNode`'s own raster not yet cached at/below `level` — still cooking;
 *   the span draws nothing rather than showing unclipped content that's
 *   about to snap into a clipped shape (draws-nothing-rather-than-guesses,
 *   same posture as `pickBestAvailable`'s callers elsewhere).
 */
function drawMaskedSpan(
  ctx: Composite2DContext,
  content: SceneNode[],
  maskNode: SceneNode,
  level: Resolution,
  scene: Scene,
  getCache: CacheLookup,
  isStale: StaleLookup,
  createScratch: CreateScratch,
): void {
  if (content.length === 0) return; // mask at the stack bottom — nothing to clip

  if (!maskNode.visible) {
    drawSpanContent(ctx, content, level, scene, getCache, isStale);
    return;
  }

  // Same locked-prefers-baked posture as `drawSpanContent` — a locked mask
  // node's clip should read its frozen full-res raster too.
  const maskRequestLevel: Resolution = maskNode.state === 'locked' ? 'baked' : level;
  const maskBest = pickBestAvailable(maskNode.id, maskRequestLevel, getCache, isStale);
  if (!maskBest) return; // mask still cooking — draw nothing rather than show it unclipped

  const [docW, docH] = scene.documentSize;
  const factor = resolutionFactorFor(level);
  const scratchW = docW * factor;
  const scratchH = docH * factor;
  const scratch = createScratch(scratchW, scratchH);
  scratch.ctx.imageSmoothingEnabled = true;

  // Seed the scratch with the live backdrop — everything painted onto `ctx`
  // by earlier spans — *before* drawing this span's own content.
  scratch.ctx.globalAlpha = 1;
  scratch.ctx.globalCompositeOperation = 'source-over';
  scratch.ctx.drawImage(ctx.canvas, 0, 0, scratchW, scratchH);

  drawSpanContent(scratch.ctx, content, level, scene, getCache, isStale);

  const [maskDestW, maskDestH] = destSizeFor(maskNode, level, scene.documentSize);
  withNodeTransform(scratch.ctx, maskNode, maskDestW, maskDestH, level, () => {
    scratch.ctx.globalAlpha = 1;
    scratch.ctx.globalCompositeOperation = 'destination-in';
    scratch.ctx.drawImage(maskBest.bitmap, 0, 0, maskDestW, maskDestH);
  });

  // Cut the hole: erase the mask's coverage from the live backdrop.
  withNodeTransform(ctx, maskNode, maskDestW, maskDestH, level, () => {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(maskBest.bitmap, 0, 0, maskDestW, maskDestH);
  });

  // Insert the blended plug — additive, not `source-over` (see doc comment).
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(scratch.canvas, 0, 0, scratchW, scratchH);
  ctx.globalCompositeOperation = 'source-over'; // restore the ambient default
}

function drawSpan(
  ctx: Composite2DContext,
  span: SceneNode[],
  level: Resolution,
  scene: Scene,
  getCache: CacheLookup,
  isStale: StaleLookup,
  createScratch: CreateScratch,
): void {
  const last = span[span.length - 1];
  if (last && last.output === 'mask') {
    drawMaskedSpan(ctx, span.slice(0, -1), last, level, scene, getCache, isStale, createScratch);
    return;
  }
  drawSpanContent(ctx, span, level, scene, getCache, isStale);
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
 * without ever writing the shared `baked` cache slot. `createScratch`
 * defaults to a real `OffscreenCanvas` factory; only masked spans ever call
 * it, so the common (no-mask) path never touches a scratch canvas at all —
 * tests without `output: 'mask'` nodes never need to stub it.
 */
export function compositeScene(
  ctx: Composite2DContext,
  scene: Scene,
  level: Resolution,
  getCache: CacheLookup = cache.get,
  createScratch: CreateScratch = realCreateScratch,
): void {
  compositeCallCount++;

  const [docW, docH] = scene.documentSize;
  if (docW <= 0 || docH <= 0) return;

  ctx.imageSmoothingEnabled = true;

  // Background paints first, onto the empty level-scaled buffer, before any
  // span/mask logic runs (background-colour.md) — plain source-over, full
  // alpha, no compositing subtlety. This is what makes the background
  // immune to masking: a masked span's scratch is seeded from this same
  // backdrop (span-backdrop-blending.md), so its destination-out/lighter
  // stamp-back restores these pixels rather than structurally being unable
  // to reach them.
  if (scene.background?.type === 'color') {
    const factor = resolutionFactorFor(level);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = scene.background.color;
    ctx.fillRect(0, 0, docW * factor, docH * factor);
  }

  // Built once per composite, not per span: a node's dirty flags are what
  // tell `pickBestAvailable` that a cached bitmap has been outrun by the
  // params it was cooked from.
  const isStale = staleLookupFor(scene);

  for (const span of splitIntoSpans(scene.nodes)) {
    drawSpan(ctx, span, level, scene, getCache, isStale, createScratch);
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
