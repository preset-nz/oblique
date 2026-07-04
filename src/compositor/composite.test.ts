import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cache from '@/scene/cache';
import * as sources from '@/scene/sources';
import type { PixelNode, Scene, SceneNode } from '@/scene/types';
import {
  type Composite2DContext,
  compositeScene,
  destSizeFor,
  getCompositeCallCount,
  pickBestAvailable,
  resetCompositeCallCount,
  resolutionFactorFor,
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
  calls: { destW: number; destH: number; alpha: number; op: GlobalCompositeOperation }[];
} {
  const calls: { destW: number; destH: number; alpha: number; op: GlobalCompositeOperation }[] = [];
  const ctx = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    imageSmoothingEnabled: false,
    drawImage: vi.fn((...args: unknown[]) => {
      const destW = args[args.length - 2] as number;
      const destH = args[args.length - 1] as number;
      calls.push({ destW, destH, alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation });
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
  return ctx as unknown as Composite2DContext & { calls: typeof calls };
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

  it('skips invisible nodes and non-image outputs', () => {
    const hidden = makeNode('hidden', { visible: false });
    const mask = makeNode('mask', { output: 'mask' });
    const visible = makeNode('visible');
    cache.set('hidden', 'working', fakeBitmap());
    cache.set('mask', 'working', fakeBitmap());
    cache.set('visible', 'working', fakeBitmap());

    const scene = makeScene([hidden, mask, visible]);
    const ctx = fakeCtx();
    compositeScene(ctx, scene, 'working');

    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
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
