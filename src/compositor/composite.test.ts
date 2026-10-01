import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cache from '@/scene/cache';
import * as sources from '@/scene/sources';
import type { PixelNode, Scene, SceneNode } from '@/scene/types';
import {
  type Composite2DContext,
  type CreateScratch,
  compositeScene,
  destSizeFor,
  getCompositeCallCount,
  pickBestAvailable,
  resetCompositeCallCount,
  resolutionFactorFor,
  spanRoles,
  splitIntoSpans,
} from './composite';

function makeNode(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
  return {
    id,
    label: id,
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    sourcePath: `/pics/${id}.png`,
    sourceSize: [200, 100],
    ...overrides,
  };
}

function makeScene(nodes: SceneNode[], documentSize: [number, number] = [200, 100]): Scene {
  return {
    id: 'scene-1',
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize,
  };
}

function fakeBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

/** Records every drawImage call's destination rect + the paint-state active at the time. */
function fakeCtx(): Composite2DContext & {
  calls: {
    src: unknown;
    destW: number;
    destH: number;
    alpha: number;
    op: GlobalCompositeOperation;
  }[];
} {
  const calls: {
    src: unknown;
    destW: number;
    destH: number;
    alpha: number;
    op: GlobalCompositeOperation;
  }[] = [];
  const ctx = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    imageSmoothingEnabled: false,
    drawImage: vi.fn((...args: unknown[]) => {
      const destW = args[args.length - 2] as number;
      const destH = args[args.length - 1] as number;
      calls.push({
        src: args[0],
        destW,
        destH,
        alpha: ctx.globalAlpha,
        op: ctx.globalCompositeOperation,
      });
    }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillStyle: '',
    fillRect: vi.fn(),
    strokeStyle: '',
    lineWidth: 0,
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
  // Self-referential sentinel: `ctx.canvas` stands in for "this context's own
  // backing surface", the same pattern `createFakeScratch` already uses for
  // a scratch's `canvas` field — good enough for the drawImage-call-recording
  // this harness does (it never inspects `src`, only dest rect/alpha/op).
  (ctx as unknown as { canvas: unknown }).canvas = ctx;
  return ctx as unknown as Composite2DContext & { calls: typeof calls };
}

/**
 * A recording scratch factory — the mask-scoping tests' stand-in for
 * `realCreateScratch` (which needs a real `OffscreenCanvas`, unavailable in
 * this node test env, same reason `rasterizeVector`/`rasterizeVectorMask`
 * are never exercised directly here). Every scratch it hands out is just another
 * `fakeCtx()`, tagged with the (w, h) it was asked for so a test can find
 * "the scratch used for this span" among however many spans got masked.
 */
function createFakeScratch(): {
  createScratch: CreateScratch;
  scratches: { width: number; height: number; ctx: ReturnType<typeof fakeCtx> }[];
} {
  const scratches: { width: number; height: number; ctx: ReturnType<typeof fakeCtx> }[] = [];
  const createScratch: CreateScratch = (width, height) => {
    const ctx = fakeCtx();
    scratches.push({ width, height, ctx });
    return { ctx, canvas: ctx as unknown as CanvasImageSource };
  };
  return { createScratch, scratches };
}

beforeEach(() => {
  cache.clearAll();
  sources.clearAll();
  // clearAll only drops decoded bitmaps — the transient missing-flags store
  // needs its own reset or striped-placeholder state leaks between tests.
  sources.useSourceMissingStore.setState({ missing: {} });
  resetCompositeCallCount();
});

describe('resolutionFactorFor', () => {
  it('baked is full resolution, working is half, draft is an eighth', () => {
    expect(resolutionFactorFor('baked')).toBe(1);
    expect(resolutionFactorFor('working')).toBe(1 / 2);
    expect(resolutionFactorFor('draft')).toBe(1 / 8);
  });
});

describe('pickBestAvailable', () => {
  it('prefers the requested level when present', () => {
    const draft = fakeBitmap();
    const working = fakeBitmap();
    cache.set('n1', 'draft', draft);
    cache.set('n1', 'working', working);
    expect(pickBestAvailable('n1', 'working')).toEqual({ bitmap: working, level: 'working' });
  });

  it('falls back to the next-lower level when the requested one is missing', () => {
    const draft = fakeBitmap();
    cache.set('n1', 'draft', draft);
    expect(pickBestAvailable('n1', 'working')).toEqual({ bitmap: draft, level: 'draft' });
  });

  it('cascades from baked all the way down to draft', () => {
    const draft = fakeBitmap();
    cache.set('n1', 'draft', draft);
    expect(pickBestAvailable('n1', 'baked')).toEqual({ bitmap: draft, level: 'draft' });
  });

  it('returns undefined when nothing is cached at or below the requested level', () => {
    expect(pickBestAvailable('n1', 'working')).toBeUndefined();
  });

  it('prefers a fresh DRAFT over a stale WORKING — the mid-scrub canvas', () => {
    const working = fakeBitmap();
    const draft = fakeBitmap();
    cache.set('n1', 'working', working); // cooked before the drag started
    cache.set('n1', 'draft', draft); // cooked 80ms into the drag
    const staleWorking = (_id: string, level: string) => level === 'working';

    expect(pickBestAvailable('n1', 'working', cache.get, staleWorking)).toEqual({
      bitmap: draft,
      level: 'draft',
    });
  });

  it('with everything stale, takes the most recently written — not the highest res', () => {
    const working = fakeBitmap();
    const draft = fakeBitmap();
    cache.set('n1', 'working', working);
    cache.set('n1', 'draft', draft); // newer: mid-drag draft cook
    const allStale = () => true;

    // The next scrub tick re-dirties DRAFT too; falling back to the
    // (higher-res, older) WORKING here would flicker the canvas back to the
    // pre-drag image between draft cooks.
    expect(pickBestAvailable('n1', 'working', cache.get, allStale)).toEqual({
      bitmap: draft,
      level: 'draft',
    });
  });

  it('keeps a fresh WORKING ahead of a DRAFT that landed after it (slow op, overtaken cook)', () => {
    const working = fakeBitmap();
    const draft = fakeBitmap();
    cache.set('n1', 'working', working);
    cache.set('n1', 'draft', draft); // newer by write order, but nothing is dirty
    expect(pickBestAvailable('n1', 'working', cache.get, () => false)).toEqual({
      bitmap: working,
      level: 'working',
    });
  });

  it('defaults to never-stale, so export (its own bitmap map, no dirty flags) is unaffected', () => {
    const baked = fakeBitmap();
    const exportLookup = (_id: string, level: string) => (level === 'baked' ? baked : undefined);
    expect(pickBestAvailable('n1', 'baked', exportLookup as never)).toEqual({
      bitmap: baked,
      level: 'baked',
    });
  });
});

describe('compositeScene staleness (architecture.md §Compositor step 3)', () => {
  it('draws the fresh DRAFT bitmap for a node dirty at WORKING (canvas updates mid-scrub)', () => {
    const ctx = fakeCtx();
    const node = makeNode('n1', { dirty: { draft: false, working: true } });
    const working = fakeBitmap();
    const draft = fakeBitmap();
    cache.set('n1', 'working', working);
    cache.set('n1', 'draft', draft);

    compositeScene(ctx, makeScene([node]), 'working');

    // Dest size always follows the composite's own level, never the bitmap's
    // — the draft stand-in still draws at WORKING size (200x100 / 2).
    expect(ctx.calls).toEqual([expect.objectContaining({ src: draft, destW: 100, destH: 50 })]);
  });

  it('draws the WORKING bitmap once nothing is dirty (the settled canvas)', () => {
    const ctx = fakeCtx();
    const node = makeNode('n1', { dirty: { draft: false, working: false } });
    const working = fakeBitmap();
    cache.set('n1', 'draft', fakeBitmap());
    cache.set('n1', 'working', working);

    compositeScene(ctx, makeScene([node]), 'working');

    expect(ctx.calls).toEqual([expect.objectContaining({ src: working })]);
  });
});

describe('splitIntoSpans', () => {
  it('walks bottom-up: array end (bottom of stack) first', () => {
    const top = makeNode('top');
    const bottom = makeNode('bottom');
    const spans = splitIntoSpans([top, bottom]);
    expect(spans).toEqual([[bottom, top]]);
  });

  it('is one span (the whole stack) when no mask nodes are present', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    expect(splitIntoSpans(nodes)).toHaveLength(1);
  });

  it('starts a new span after each mask-output node (hook for Epic 06)', () => {
    const top = makeNode('top');
    const mask = makeNode('mask', { output: 'mask' });
    const bottom = makeNode('bottom');
    // array order top-to-bottom is [top, mask, bottom]; bottom-up walk visits
    // bottom, mask, top — the mask ends the first span.
    const spans = splitIntoSpans([top, mask, bottom]);
    expect(spans).toEqual([[bottom, mask], [top]]);
  });
});

describe('spanRoles', () => {
  const img = (id: string) => makeNode(id);
  const mask = (id: string) => makeNode(id, { output: 'mask' });

  it("Georg's layout: members indent under the mask above them", () => {
    const nodes = [mask('m1'), img('a'), img('b'), mask('m2'), img('c')];
    expect(spanRoles(nodes)).toEqual(['head', 'member', 'member', 'head', 'member']);
  });

  it('nodes above every mask are unspanned', () => {
    const nodes = [img('top'), mask('m'), img('under')];
    expect(spanRoles(nodes)).toEqual(['none', 'head', 'member']);
  });

  it('a mask at the stack bottom has no members', () => {
    expect(spanRoles([img('a'), mask('m')])).toEqual(['none', 'head']);
    expect(spanRoles([mask('m')])).toEqual(['head']);
  });

  it('a stack with no masks is all unspanned; empty stack is empty', () => {
    expect(spanRoles([img('a'), img('b')])).toEqual(['none', 'none']);
    expect(spanRoles([])).toEqual([]);
  });

  it('adjacent masks are each a head with no members between them', () => {
    expect(spanRoles([mask('m1'), mask('m2'), img('a')])).toEqual(['head', 'head', 'member']);
  });

  it('re-derives on output toggle, reorder and delete', () => {
    const a = img('a');
    const b = img('b');
    const c = img('c');
    expect(spanRoles([a, b, c])).toEqual(['none', 'none', 'none']);
    // toggle b to mask: c becomes its member
    const b2 = { ...b, output: 'mask' as const };
    expect(spanRoles([a, b2, c])).toEqual(['none', 'head', 'member']);
    // reorder: mask to the top
    expect(spanRoles([b2, a, c])).toEqual(['head', 'member', 'member']);
    // delete the mask: back to none
    expect(spanRoles([a, c])).toEqual(['none', 'none']);
  });

  it('ignores visibility: a hidden mask still heads its span', () => {
    const hidden = makeNode('m', { output: 'mask', visible: false });
    expect(spanRoles([hidden, img('a')])).toEqual(['head', 'member']);
  });
});

describe('destSizeFor — the multi-aspect-import fix', () => {
  it('scales a pixel node by its own sourceSize, not documentSize', () => {
    const node = makeNode('n1', { sourceSize: [300, 100] });
    const documentSize: [number, number] = [200, 200]; // different aspect ratio than the node
    expect(destSizeFor(node, 'working', documentSize)).toEqual([150, 50]);
  });
});

describe('compositeScene', () => {
  it('paints nodes bottom-up, each at its own sourceSize (not stretched to documentSize)', () => {
    const wideBitmap = fakeBitmap();
    const tallBitmap = fakeBitmap();
    const wide = makeNode('wide', { sourceSize: [400, 100] }); // 4:1
    const tall = makeNode('tall', { sourceSize: [100, 400] }); // 1:4
    cache.set('wide', 'working', wideBitmap);
    cache.set('tall', 'working', tallBitmap);

    // documentSize deliberately square — neither node's aspect ratio.
    const scene = makeScene([tall, wide], [200, 200]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    // bottom-up: array end (`wide`) draws first, then `tall`.
    expect(ctx.drawImage).toHaveBeenNthCalledWith(1, wideBitmap, 0, 0, 200, 50);
    expect(ctx.drawImage).toHaveBeenNthCalledWith(2, tallBitmap, 0, 0, 50, 200);
  });

  it('skips invisible nodes', () => {
    // No mask node here — a mask-terminated span is covered under "mask
    // scoping" below, where the scratch/clip machinery needs a stubbed
    // createScratch (the default reaches for a real OffscreenCanvas).
    const hidden = makeNode('hidden', { visible: false });
    const visible = makeNode('visible');
    cache.set('hidden', 'working', fakeBitmap());
    cache.set('visible', 'working', fakeBitmap());

    const scene = makeScene([hidden, visible]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('a mask-output node never draws itself directly, even outside a masked span', () => {
    // Array order [mask]: a lone mask node with nothing below it — the
    // "stack bottom" no-op case, exercised again more explicitly below.
    const mask = makeNode('mask', { output: 'mask' });
    cache.set('mask', 'working', fakeBitmap());
    const scene = makeScene([mask]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('draws nothing for a node with no cache at or below the requested level', () => {
    const node = makeNode('n1');
    const scene = makeScene([node]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('sets globalAlpha and globalCompositeOperation per node before drawing', () => {
    const a = makeNode('a', { opacity: 0.4, blendMode: 'multiply' });
    const b = makeNode('b', { opacity: 1, blendMode: 'screen' });
    cache.set('a', 'working', fakeBitmap());
    cache.set('b', 'working', fakeBitmap());

    // Array order [a, b]: bottom-up draws b then a.
    const scene = makeScene([a, b]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    expect(ctx.calls[0]).toMatchObject({ alpha: 1, op: 'screen' });
    expect(ctx.calls[1]).toMatchObject({ alpha: 0.4, op: 'multiply' });
  });

  it('draws a striped placeholder (source-over, full alpha) for a missing source', () => {
    const node = makeNode('n1', { opacity: 0.3, blendMode: 'multiply' });
    sources.useSourceMissingStore.getState().setMissing('n1', true);
    const scene = makeScene([node]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalled(); // placeholder background
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });

  it('is a no-op for a zero-size document', () => {
    const scene = makeScene([makeNode('n1')], [0, 0]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('increments the dev recomposite counter once per call', () => {
    const scene = makeScene([]);
    const ctx = fakeCtx();
    expect(getCompositeCallCount()).toBe(0);
    compositeScene(ctx, scene, 'working');
    compositeScene(ctx, scene, 'working');
    expect(getCompositeCallCount()).toBe(2);
  });

  describe('locked nodes prefer baked (lock-state-machine.md)', () => {
    it('requests baked instead of the composite level for a locked node', () => {
      const bakedBitmap = fakeBitmap();
      const workingBitmap = fakeBitmap();
      const node = makeNode('a', { state: 'locked' });
      cache.set('a', 'baked', bakedBitmap);
      cache.set('a', 'working', workingBitmap);

      const scene = makeScene([node]);
      const ctx = fakeCtx();
      compositeScene(ctx, scene, 'working');

      expect(ctx.drawImage).toHaveBeenCalledWith(bakedBitmap, 0, 0, 100, 50);
    });

    it('draws at the composite-level dest size, not full res, even for a locked node', () => {
      const node = makeNode('a', { state: 'locked', sourceSize: [400, 200] });
      cache.set('a', 'baked', fakeBitmap());

      const scene = makeScene([node], [400, 200]);
      const ctx = fakeCtx();
      compositeScene(ctx, scene, 'working');

      // destSizeFor stays keyed on the composite's OWN level (working = 1/2),
      // not on the per-node baked request level — a locked node's draw size
      // must never mismatch its siblings.
      expect(ctx.calls[0]).toMatchObject({ destW: 200, destH: 100 });
    });

    it('falls back through the existing cascade when baked is not yet rehydrated', () => {
      const workingBitmap = fakeBitmap();
      const node = makeNode('a', { state: 'locked' });
      cache.set('a', 'working', workingBitmap);

      const scene = makeScene([node]);
      const ctx = fakeCtx();
      compositeScene(ctx, scene, 'working');

      expect(ctx.drawImage).toHaveBeenCalledWith(workingBitmap, 0, 0, 100, 50);
    });

    it('an unlocked node still requests the composite level, ignoring any baked cache', () => {
      const bakedBitmap = fakeBitmap();
      const workingBitmap = fakeBitmap();
      const node = makeNode('a', { state: 'active' });
      cache.set('a', 'baked', bakedBitmap);
      cache.set('a', 'working', workingBitmap);

      const scene = makeScene([node]);
      const ctx = fakeCtx();
      compositeScene(ctx, scene, 'working');

      expect(ctx.drawImage).toHaveBeenCalledWith(workingBitmap, 0, 0, 100, 50);
    });
  });
});

describe('mask scoping — compositor span walk (mask-span-scoping.md)', () => {
  it('clips a span to the mask node above it via a scratch canvas + destination-in', () => {
    // Array order top-to-bottom [top, mask, bottom]; bottom-up walk visits
    // bottom, mask, top — bottom is the masked span, top is untouched.
    const top = makeNode('top');
    const mask = makeNode('mask', { output: 'mask' });
    const bottom = makeNode('bottom');
    const maskBitmap = fakeBitmap();
    cache.set('top', 'baked', fakeBitmap());
    cache.set('mask', 'baked', maskBitmap);
    cache.set('bottom', 'baked', fakeBitmap());

    const scene = makeScene([top, mask, bottom]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    // Exactly one span got masked (one scratch canvas created).
    expect(scratches).toHaveLength(1);
    const scratch = scratches[0];

    // The scratch is seeded with the live backdrop first, `bottom` draws on
    // top of that (not onto the main canvas), then the mask clips it.
    expect(scratch.ctx.drawImage).toHaveBeenCalledTimes(3); // seed, bottom, mask bitmap
    expect(scratch.ctx.calls[0]).toMatchObject({ op: 'source-over', alpha: 1 }); // backdrop seed
    expect(scratch.ctx.calls[2]).toMatchObject({ op: 'destination-in', alpha: 1 });

    // Stamp-back is "cut the hole, insert the blended plug": destination-out
    // with the mask erases its coverage from the live backdrop, then the
    // clipped scratch lands with `lighter` (additive on premultiplied
    // values) — never `source-over`, which would double-discount the
    // already-cut hole at feathered edges (span-backdrop-blending.md).
    expect(ctx.drawImage).toHaveBeenCalledTimes(3); // cut, plug, then `top` straight through
    expect(ctx.drawImage).toHaveBeenNthCalledWith(1, maskBitmap, 0, 0, 200, 100);
    expect(ctx.calls[0]).toMatchObject({ op: 'destination-out', alpha: 1 });
    // `createFakeScratch` hands out the scratch's own ctx as its `canvas` too.
    expect(ctx.drawImage).toHaveBeenNthCalledWith(2, scratch.ctx, 0, 0, 200, 100);
    expect(ctx.calls[1]).toMatchObject({ op: 'lighter', alpha: 1 });
  });

  it('a mask node with nothing below it (stack bottom) is a no-op, not an error', () => {
    const image = makeNode('image');
    const mask = makeNode('mask', { output: 'mask' });
    cache.set('image', 'baked', fakeBitmap());
    cache.set('mask', 'baked', fakeBitmap());

    // Array order [image, mask]: mask is the bottom of the stack — its span
    // is just itself, content = [].
    const scene = makeScene([image, mask]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches).toHaveLength(0); // never even reaches for a scratch canvas
    expect(ctx.drawImage).toHaveBeenCalledTimes(1); // image, unclipped
  });

  it('a second mask node lower in the stack bounds a second, independent span', () => {
    // Array order top-to-bottom [top, maskA, middle, maskB, bottom]:
    // bottom-up walk gives spans [bottom, maskB], [middle, maskA], [top].
    const top = makeNode('top');
    const maskA = makeNode('maskA', { output: 'mask' });
    const middle = makeNode('middle');
    const maskB = makeNode('maskB', { output: 'mask' });
    const bottom = makeNode('bottom');
    for (const n of [top, maskA, middle, maskB, bottom]) cache.set(n.id, 'baked', fakeBitmap());

    const scene = makeScene([top, maskA, middle, maskB, bottom]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches).toHaveLength(2); // two independent masked spans
    // Scratch content is never shared across spans.
    expect(scratches[0].ctx.drawImage).toHaveBeenCalledTimes(3); // seed + bottom + maskB
    expect(scratches[1].ctx.drawImage).toHaveBeenCalledTimes(3); // seed + middle + maskA
    // Two masked spans (cut + plug each) onto the main canvas, plus `top`
    // drawn straight through.
    expect(ctx.drawImage).toHaveBeenCalledTimes(5);
  });

  it('a hidden mask node stops clipping — its span draws straight through, unclipped', () => {
    const mask = makeNode('mask', { output: 'mask', visible: false });
    const bottom = makeNode('bottom');
    cache.set('mask', 'baked', fakeBitmap());
    cache.set('bottom', 'baked', fakeBitmap());

    const scene = makeScene([mask, bottom]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches).toHaveLength(0); // no scratch — drawn straight onto ctx
    expect(ctx.drawImage).toHaveBeenCalledTimes(1); // bottom, unclipped
  });

  it('a masked span draws nothing while the mask itself is still cooking (no cache at/below level)', () => {
    const mask = makeNode('mask', { output: 'mask' }); // no cache.set for 'mask'
    const bottom = makeNode('bottom');
    cache.set('bottom', 'baked', fakeBitmap());

    const scene = makeScene([mask, bottom]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches).toHaveLength(0);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('toggling output image<->mask changes only which draw path runs, never touches the cache', () => {
    // Same node, same cache entry, only `output` differs — the acceptance's
    // "recomposites without recooking" claim, expressed as: the mask's own
    // raster (its cache bitmap) is reused unchanged by both draw paths.
    const bitmap = fakeBitmap();
    cache.set('n1', 'baked', bitmap);

    const asImage = makeNode('n1', { output: 'image' });
    const sceneImage = makeScene([asImage]);
    const ctxImage = fakeCtx();
    compositeScene(ctxImage, sceneImage, 'baked');
    expect(ctxImage.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 200, 100);

    const asMask = makeNode('n1', { output: 'mask' });
    const sceneMask = makeScene([asMask]);
    const ctxMask = fakeCtx();
    compositeScene(ctxMask, sceneMask, 'baked');
    // Bottom-of-stack mask, nothing below it — no-op, same bitmap untouched.
    expect(ctxMask.drawImage).not.toHaveBeenCalled();
  });

  it('a blurred mask feathers the clip — the compositor just draws whatever the mask node cooked', () => {
    // The compositor doesn't know or care that a blur ran; it only ever
    // reads the mask node's *cooked* cache bitmap (mask-span-scoping.md:
    // "the mask raster runs the normal cook path first"). This test proves
    // the compositor treats a feathered mask bitmap identically to a crisp
    // one — cook.ts/vectorRasterize.ts own the actual blur maths.
    const featheredMaskBitmap = fakeBitmap();
    const bottom = makeNode('bottom');
    const mask = makeNode('mask', { output: 'mask' });
    cache.set('mask', 'baked', featheredMaskBitmap);
    cache.set('bottom', 'baked', fakeBitmap());

    const scene = makeScene([mask, bottom]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches[0].ctx.drawImage).toHaveBeenNthCalledWith(
      3,
      featheredMaskBitmap,
      0,
      0,
      200,
      100,
    );
    expect(scratches[0].ctx.calls[2].op).toBe('destination-in');
  });

  it("ignores the mask node's own blendMode/opacity (source spec)", () => {
    const mask = makeNode('mask', { output: 'mask', opacity: 0.2, blendMode: 'multiply' });
    const bottom = makeNode('bottom');
    cache.set('mask', 'baked', fakeBitmap());
    cache.set('bottom', 'baked', fakeBitmap());

    const scene = makeScene([mask, bottom]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches[0].ctx.calls[2]).toMatchObject({ alpha: 1, op: 'destination-in' });
  });
});

describe('span-backdrop-blending.md — masked spans blend against the backdrop', () => {
  it("seeds the scratch with the live backdrop before drawing the span's own content, so a member node's blendMode/opacity is applied identically with or without a mask above it", () => {
    // Same content node, same blend/opacity, once with nothing above it
    // (draws straight onto the main canvas) and once under a mask (draws
    // into the backdrop-seeded scratch) — the node's own drawImage call
    // (op/alpha) must be identical either way. That's the "pixel-identical
    // modulo the clip itself" acceptance, expressed as an operator-sequence
    // assertion (the fake-canvas harness computes no pixels).
    const content = makeNode('content', { blendMode: 'multiply', opacity: 0.6 });
    cache.set('content', 'baked', fakeBitmap());

    const unmaskedScene = makeScene([content]);
    const unmaskedCtx = fakeCtx();
    compositeScene(unmaskedCtx, unmaskedScene, 'baked');
    expect(unmaskedCtx.calls).toHaveLength(1);
    const unmaskedCall = unmaskedCtx.calls[0];

    const mask = makeNode('mask', { output: 'mask' });
    cache.set('mask', 'baked', fakeBitmap());
    const maskedScene = makeScene([mask, content]); // mask on top, content below it
    const maskedCtx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(maskedCtx, maskedScene, 'baked', cache.get, createScratch);

    // scratches[0].calls[0] is the backdrop seed; calls[1] is `content` itself.
    const maskedCall = scratches[0].ctx.calls[1];
    expect(maskedCall).toEqual(unmaskedCall);
  });

  it('a one-image span multiplies/screens against the backdrop, not against an empty scratch', () => {
    // The defect this story fixes: before the backdrop seed, a masked span's
    // member nodes blended against transparency, which renders identically
    // to `normal` — this is the regression test for that.
    const backdropNode = makeNode('backdrop');
    const mask = makeNode('mask', { output: 'mask' });
    const topSpanMember = makeNode('top-member', { blendMode: 'multiply' });
    cache.set('backdrop', 'baked', fakeBitmap());
    cache.set('mask', 'baked', fakeBitmap());
    cache.set('top-member', 'baked', fakeBitmap());

    // Array order top-to-bottom [top-member, mask, backdrop]: bottom-up walk
    // gives spans [backdrop, mask] (masked, drawn first), then [top-member]
    // (unmasked, drawn straight onto `ctx` afterwards). The masked span's
    // scratch must be seeded with the live backdrop *before* `backdrop`
    // itself draws, so `backdrop`'s own multiply/screen (if any) — and any
    // later member's — sees real pixels, not transparency: the scratch's
    // very first drawImage call is always the backdrop-seed copy
    // (`source-over`/alpha 1), never skipped.
    const scene = makeScene([topSpanMember, mask, backdropNode]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches).toHaveLength(1);
    expect(scratches[0].ctx.calls[0]).toMatchObject({ op: 'source-over', alpha: 1 });
  });

  it('feathered mask over a transparent background: stamp-back uses destination-out + lighter, never source-over, so soft edges are not double-composited', () => {
    // Proof sketch (full algebra in drawMaskedSpan's doc comment): in
    // premultiplied space, `destination-out` with mask alpha M leaves
    // `backdrop*(1-M)` on the main canvas; the scratch (already
    // `destination-in`-clipped) holds `blended*M`. Stamping the clipped
    // scratch with `lighter` (pure premultiplied addition) yields
    // `backdrop*(1-M) + blended*M` — the exact coverage-weighted lerp, with
    // no cross term. `source-over` would instead multiply the backdrop
    // remainder by `(1 - blended.alpha*M)`, under-counting alpha at any
    // pixel where 0 < M < 1 (a feathered edge) over a transparent
    // background and producing a visible halo — this test locks the
    // operator choice in.
    const bottom = makeNode('bottom');
    const mask = makeNode('mask', { output: 'mask' }); // stands in for a feathered (blurred) mask raster
    cache.set('bottom', 'baked', fakeBitmap());
    cache.set('mask', 'baked', fakeBitmap());

    const scene = makeScene([mask, bottom]);
    const ctx = fakeCtx();
    const { createScratch, scratches } = createFakeScratch();
    compositeScene(ctx, scene, 'baked', cache.get, createScratch);

    expect(scratches).toHaveLength(1);
    expect(ctx.calls.map((c) => c.op)).toEqual(['destination-out', 'lighter']);
    expect(ctx.calls.every((c) => c.alpha === 1)).toBe(true);
  });
});

describe('document background colour (background-colour.md)', () => {
  it('an absent background paints nothing extra — no fillRect call', () => {
    const scene = makeScene([]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('fills the full level-scaled buffer, source-over/full alpha, before the span walk runs', () => {
    const node = makeNode('n1');
    cache.set('n1', 'working', fakeBitmap());
    const scene = makeScene([node]);
    scene.background = { type: 'color', color: '#112233' };
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    // documentSize is [200, 100]; working = half factor -> [100, 50].
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 100, 50);
    expect(ctx.fillStyle).toBe('#112233');

    // The fill happens before any node's drawImage call.
    const fillOrder = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const drawOrder = (ctx.drawImage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(fillOrder).toBeLessThan(drawOrder);
  });

  it('scales the fill to baked (full) resolution', () => {
    const scene = makeScene([], [200, 100]);
    scene.background = { type: 'color', color: '#ffffff' };
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'baked');
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
  });

  it(
    'a masked span whose content reaches the stack bottom does not change the background fill ' +
      'call itself — same fillRect params/order with or without the mask above the content ' +
      '(structural half of the story acceptance; the arithmetic half — that the backdrop-seeded ' +
      'scratch restores these pixels within epsilon at feathered edges — needs real pixel math this ' +
      'fake-canvas harness cannot produce; see the story report)',
    () => {
      const content = makeNode('content');
      cache.set('content', 'baked', fakeBitmap());

      const unmaskedScene = makeScene([content]);
      unmaskedScene.background = { type: 'color', color: '#abcdef' };
      const unmaskedCtx = fakeCtx();
      compositeScene(unmaskedCtx, unmaskedScene, 'baked');

      const mask = makeNode('mask', { output: 'mask' });
      cache.set('mask', 'baked', fakeBitmap());
      // Array order [mask, content]: content is the bottom-most node, mask
      // sits directly above it — this masked span reaches the stack bottom.
      const maskedScene = makeScene([mask, content]);
      maskedScene.background = { type: 'color', color: '#abcdef' };
      const maskedCtx = fakeCtx();
      const { createScratch } = createFakeScratch();
      compositeScene(maskedCtx, maskedScene, 'baked', cache.get, createScratch);

      expect(maskedCtx.fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
      expect(unmaskedCtx.fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
      expect(maskedCtx.fillStyle).toBe(unmaskedCtx.fillStyle);
    },
  );
});

describe('transform2d — compositing-only node transform (node-transform-2d.md)', () => {
  it('an absent transform2d draws identically to before (no save/translate/rotate/scale side effects)', () => {
    const node = makeNode('n1');
    cache.set('n1', 'baked', fakeBitmap());
    const scene = makeScene([node]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'baked');

    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 100);
    expect(ctx.translate).not.toHaveBeenCalled();
    expect(ctx.rotate).not.toHaveBeenCalled();
    expect(ctx.scale).not.toHaveBeenCalled();
    // Still balanced save/restore around every node's draw, transform or not.
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it('a translate-only transform2d at baked level translates by exactly (x, y)', () => {
    const node = makeNode('n1', {
      transform2d: { x: 30, y: 10, scaleX: 1, scaleY: 1, rotation: 0 },
    });
    cache.set('n1', 'baked', fakeBitmap());
    const scene = makeScene([node]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'baked');

    // translate(x*factor, y*factor) then translate(cx, cy) then translate(-cx, -cy)
    // nets to a pure (x, y) shift at factor 1 (baked).
    expect(ctx.translate).toHaveBeenNthCalledWith(1, 30, 10);
    expect(ctx.rotate).toHaveBeenCalledWith(0);
    expect(ctx.scale).toHaveBeenCalledWith(1, 1);
  });

  it('scales the translation by the level factor (working = half) but leaves scale/rotation untouched', () => {
    const node = makeNode('n1', {
      sourceSize: [200, 100],
      transform2d: { x: 40, y: 20, scaleX: 2, scaleY: 0.5, rotation: Math.PI / 4 },
    });
    cache.set('n1', 'working', fakeBitmap());
    const scene = makeScene([node]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    expect(ctx.translate).toHaveBeenNthCalledWith(1, 20, 10); // 40*0.5, 20*0.5
    expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 4);
    expect(ctx.scale).toHaveBeenCalledWith(2, 0.5);
  });

  it('brackets every node draw (transformed or not) in a balanced save/restore, never leaking on early continue', () => {
    const missing = makeNode('missing', {
      transform2d: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
    });
    sources.useSourceMissingStore.getState().setMissing('missing', true);
    const noCache = makeNode('noCache');
    const scene = makeScene([missing, noCache]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    // missing-source path: withNodeTransform's own save/restore, plus
    // drawStripedPlaceholder's internal clip save/restore = 2; no-cache path
    // draws nothing and must never leak an unmatched save.
    expect(ctx.save).toHaveBeenCalledTimes(2);
    expect(ctx.restore).toHaveBeenCalledTimes(2);
  });
});
