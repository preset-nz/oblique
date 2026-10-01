import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpDescriptor } from '@/sidecar/opsCache';
import type { TextGeometry } from '../fonts/textGeometry';
import type { Modifier, PixelNode, SceneNode, TextNode, VectorNode } from '../scene/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { toast } from 'sonner';
import {
  buildCookModifiers,
  type CookDeps,
  type CookLevel,
  type CookModifier,
  computeTargetSize,
  cookNode,
  cookNodeFullRes,
  type FullResCookDeps,
  packMaskedPayload,
  partitionRuns,
  resetCookErrorBurst,
  resolutionFactor,
} from './cook';
import { useLastCookStore } from './lastCook';
import type { PrefixEntry } from './prefixCache';

function fakeBitmap(): ImageBitmap {
  return {} as unknown as ImageBitmap;
}

function makeNode(overrides: Partial<PixelNode> = {}): SceneNode {
  return {
    id: 'node-1',
    label: 'Layer',
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: true, working: true },
    sourcePath: '/a.png',
    sourceSize: [800, 400],
    ...overrides,
  } as SceneNode;
}

function makeVectorNode(overrides: Partial<VectorNode> = {}): SceneNode {
  return {
    id: 'node-1',
    label: 'Vector',
    type: 'vector',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: true, working: true },
    paths: [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 10, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ],
    fillRule: 'nonzero',
    ...overrides,
  } as SceneNode;
}

const emptyGeometry: TextGeometry = { paths: [], lines: [], ascent: 0, descent: 0, bounds: null };

function makeTextNode(overrides: Partial<TextNode> = {}): TextNode {
  return {
    id: 'node-1',
    label: 'Text',
    type: 'text',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: true, working: true },
    content: 'HELLO',
    font: {
      family: 'Helvetica',
      style: 'Regular',
      postscriptName: 'Helvetica',
      weight: 400,
      italic: false,
      category: 'sans',
    },
    fontSize: 72,
    tracking: 0,
    kerning: 100,
    lineHeight: 1.2,
    align: 'left',
    fill: '#ffffff',
    stroke: null,
    position: { x: 10, y: 60 },
    ...overrides,
  };
}

/** A minimal CookDeps with all browser/sidecar edges stubbed; individual fields overridable per test. */
function makeDeps(nodeRef: { current: SceneNode }, overrides: Partial<CookDeps> = {}): CookDeps {
  // Stable source identity (the prefix cache compares the ImageBitmap with ===)
  // and fresh in-memory prefix storage per deps object — nothing leaks between tests.
  const sourceBitmap = fakeBitmap();
  const prefixes = new Map<string, PrefixEntry>();
  const lastStacks = new Map<string, string[]>();
  return {
    getNode: vi.fn((id: string) => (nodeRef.current.id === id ? nodeRef.current : undefined)),
    getSource: vi.fn(() => sourceBitmap),
    getDocumentSize: vi.fn(() => [800, 400] as [number, number]),
    getOps: vi.fn(() => opsFixture),
    getVectorMaskRef: vi.fn(() => undefined),
    rasterizeVectorMask: vi.fn(
      (
        _paths,
        _fillRule,
        _ref,
        _vecTransform,
        _docSize,
        _consumerTransform,
        _consumerSourceSize,
        w: number,
        h: number,
        _factor: number,
      ) => new Uint8Array(w * h),
    ),
    downscale: vi.fn((_src: ImageBitmap, w: number, h: number) => new Uint8Array(w * h * 4)),
    rasterizeVector: vi.fn(
      (_paths, _fillRule, w: number, h: number, _factor: number) => new Uint8Array(w * h * 4),
    ),
    getTextGeometry: vi.fn(async () => emptyGeometry),
    rasterizeText: vi.fn(
      (_node, _geometry, w: number, h: number, _factor: number) => new Uint8Array(w * h * 4),
    ),
    runPython: vi.fn(async (w: number, h: number) => new Uint8Array(w * h * 4)),
    encode: vi.fn(async () => fakeBitmap()),
    setCache: vi.fn(),
    clearDirty: vi.fn(),
    getPrefix: vi.fn((id: string, level: CookLevel) => prefixes.get(`${id}:${level}`)),
    setPrefix: vi.fn((id: string, level: CookLevel, entry: PrefixEntry) => {
      prefixes.set(`${id}:${level}`, entry);
    }),
    getLastStack: vi.fn((id: string, level: CookLevel) => lastStacks.get(`${id}:${level}`)),
    setLastStack: vi.fn((id: string, level: CookLevel, descriptors: string[]) => {
      lastStacks.set(`${id}:${level}`, descriptors);
    }),
    ...overrides,
  };
}

describe('resolutionFactor / computeTargetSize', () => {
  it('draft is 1/8, working is 1/2', () => {
    expect(resolutionFactor('draft')).toBeCloseTo(1 / 8);
    expect(resolutionFactor('working')).toBeCloseTo(1 / 2);
  });

  it('rounds and floors at 1px minimum', () => {
    expect(computeTargetSize([800, 400], 1 / 8)).toEqual([100, 50]);
    expect(computeTargetSize([3, 3], 1 / 8)).toEqual([1, 1]);
    expect(computeTargetSize([5, 5], 1 / 2)).toEqual([3, 3]); // round(2.5) = 3 (JS round-half-up)
  });
});

const opsFixture: OpDescriptor[] = [
  {
    name: 'gaussian_blur',
    backend: 'python',
    params: [{ name: 'radius', type: 'float', default: 4, min: 0, max: 100, scale: 'spatial' }],
  },
  {
    name: 'levels',
    backend: 'python',
    params: [{ name: 'black', type: 'int', default: 0, min: 0, max: 255, scale: 'none' }],
  },
  {
    name: 'colourise',
    backend: 'python',
    params: [{ name: 'ink', type: 'color', default: '#00ffff', scale: 'none' }],
  },
];

describe('buildCookModifiers', () => {
  const modifiers: Modifier[] = [
    { id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } },
    { id: 'm2', type: 'levels', enabled: true, params: { black: 10 } },
    { id: 'm3', type: 'gaussian_blur', enabled: false, params: { radius: 20 } },
  ];

  it('filters disabled modifiers', () => {
    const built = buildCookModifiers(modifiers, 1 / 2, opsFixture);
    expect(built).toHaveLength(2);
  });

  it('scales spatial params by the factor, leaves non-spatial alone', () => {
    const built = buildCookModifiers(modifiers, 1 / 2, opsFixture);
    expect(built[0]).toMatchObject({ type: 'gaussian_blur', params: { radius: 4 } });
    expect(built[1]).toMatchObject({ type: 'levels', params: { black: 10 } });
  });

  it('passes params through unscaled for an op missing from the registry', () => {
    const built = buildCookModifiers(
      [{ id: 'm4', type: 'unknown_op', enabled: true, params: { amount: 5 } }],
      1 / 8,
      opsFixture,
    );
    expect(built).toEqual([{ type: 'unknown_op', backend: 'python', params: { amount: 5 } }]);
  });

  it('leaves a colour param string untouched at any resolution factor, while a numeric spatial param in the same call is still scaled (Epic 15 — proves the guard is live, not just untriggered)', () => {
    const mixed: Modifier[] = [
      { id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } },
      { id: 'm5', type: 'colourise', enabled: true, params: { ink: '#ff00ff' } },
    ];
    const draft = buildCookModifiers(mixed, 1 / 8, opsFixture);
    const working = buildCookModifiers(mixed, 1 / 2, opsFixture);

    expect(draft[0]).toMatchObject({ type: 'gaussian_blur', params: { radius: 1 } });
    expect(draft[1]).toMatchObject({ type: 'colourise', params: { ink: '#ff00ff' } });

    expect(working[0]).toMatchObject({ type: 'gaussian_blur', params: { radius: 4 } });
    expect(working[1]).toMatchObject({ type: 'colourise', params: { ink: '#ff00ff' } });
  });
});

describe('buildCookModifiers — masks', () => {
  const maskedModifiers: Modifier[] = [
    { id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 }, maskId: 'mask-1' },
    { id: 'm2', type: 'levels', enabled: true, params: { black: 10 } },
    { id: 'm3', type: 'levels', enabled: false, params: { black: 5 }, maskId: 'mask-2' },
  ];

  it('attaches the rasterised plane to masked modifiers only', () => {
    const plane = new Uint8Array(16);
    const rasterizeFor = vi.fn((maskId: string) => (maskId === 'mask-1' ? plane : undefined));

    const built = buildCookModifiers(maskedModifiers, 1, opsFixture, rasterizeFor);

    expect(built[0].mask).toBe(plane);
    expect(built[1].mask).toBeUndefined();
    // The disabled modifier is filtered before its mask is ever rasterised.
    expect(rasterizeFor).toHaveBeenCalledTimes(1);
  });

  it('ignores masks entirely when no rasteriser is supplied', () => {
    const built = buildCookModifiers(maskedModifiers, 1, opsFixture);
    expect(built.every((m) => m.mask === undefined)).toBe(true);
  });
});

describe('packMaskedPayload', () => {
  const image = Uint8Array.from([1, 2, 3, 4]);

  it('zero masked modifiers: image untouched, no masks array (byte-identical request)', () => {
    const modifiers: CookModifier[] = [
      { type: 'levels', backend: 'python', params: {} },
      { type: 'gaussian_blur', backend: 'python', params: {} },
    ];
    const packed = packMaskedPayload(image, modifiers);
    expect(packed.masks).toBeUndefined();
    expect(packed.payload).toBe(image); // same reference — not even a copy
  });

  it('appends mask planes after the image in modifier order with per-mask lengths', () => {
    const maskA = Uint8Array.from([10, 11]);
    const maskB = Uint8Array.from([20, 21, 22]);
    const modifiers: CookModifier[] = [
      { type: 'levels', backend: 'python', params: {}, mask: maskA },
      { type: 'gaussian_blur', backend: 'python', params: {} },
      { type: 'invert', backend: 'python', params: {}, mask: maskB },
    ];

    const packed = packMaskedPayload(image, modifiers);

    expect(packed.masks).toEqual([
      { modifierIndex: 0, mask_bytes: 2 },
      { modifierIndex: 2, mask_bytes: 3 },
    ]);
    expect(Array.from(packed.payload)).toEqual([1, 2, 3, 4, 10, 11, 20, 21, 22]);
  });
});

describe('cookNode — masks', () => {
  function maskedConsumerSetup() {
    const vectorRef = { current: makeVectorNode({ id: 'v1' }) as VectorNode };
    const ref = { id: 'ref-1', nodeId: 'v1', featherPx: 0, expand: 0, invert: false };
    const nodeRef = {
      current: makeNode({
        modifiers: [
          {
            id: 'm1',
            type: 'gaussian_blur',
            enabled: true,
            params: { radius: 8 },
            maskId: 'ref-1',
          },
        ],
      }),
    };
    return { vectorRef, ref, nodeRef };
  }

  it('race guard: a mask-source edit mid-cook (consumer modifiers untouched) leaves dirty set', async () => {
    const { vectorRef, ref, nodeRef } = maskedConsumerSetup();
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn(() => ref),
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 'v1' ? vectorRef.current : undefined,
      ),
      runPython: vi.fn(async (_w: number, _h: number, _m: CookModifier[], payload: Uint8Array) => {
        // setVectorPaths on the mask source: new paths, and
        // dirtyMaskRefConsumers replaces the consumer with a fresh dirty flag —
        // its `modifiers` array is the same reference.
        vectorRef.current = { ...vectorRef.current, paths: [] };
        nodeRef.current = { ...nodeRef.current, dirty: { draft: true, working: true } };
        return payload;
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.setCache).toHaveBeenCalledTimes(1);
    expect(deps.clearDirty).not.toHaveBeenCalled();
  });

  it('race guard: a consumer move mid-cook leaves a vector-masked node dirty', async () => {
    const { vectorRef, ref, nodeRef } = maskedConsumerSetup();
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn(() => ref),
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 'v1' ? vectorRef.current : undefined,
      ),
      runPython: vi.fn(async (_w: number, _h: number, _m: CookModifier[], payload: Uint8Array) => {
        nodeRef.current = {
          ...nodeRef.current,
          transform2d: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
        };
        return payload;
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.clearDirty).not.toHaveBeenCalled();
  });

  it('race guard: a consumer move mid-cook does NOT block clearing dirty for a node-pinned mask (mask-follows-node.md)', async () => {
    const { vectorRef, ref, nodeRef } = maskedConsumerSetup();
    const nodePinned = {
      ...ref,
      space: 'node' as const,
      attachTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    };
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn(() => nodePinned),
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 'v1' ? vectorRef.current : undefined,
      ),
      runPython: vi.fn(async (_w: number, _h: number, _m: CookModifier[], payload: Uint8Array) => {
        nodeRef.current = {
          ...nodeRef.current,
          transform2d: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
        };
        return payload;
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.clearDirty).toHaveBeenCalledWith('node-1', 'draft');
  });

  it('race guard: an unrelated dirty flip on a masked consumer still clears dirty', async () => {
    const { vectorRef, ref, nodeRef } = maskedConsumerSetup();
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn(() => ref),
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 'v1' ? vectorRef.current : undefined,
      ),
      runPython: vi.fn(async (_w: number, _h: number, _m: CookModifier[], payload: Uint8Array) => {
        nodeRef.current = { ...nodeRef.current, dirty: { draft: true, working: true } };
        vectorRef.current = { ...vectorRef.current, dirty: { draft: false, working: false } };
        return payload;
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.clearDirty).toHaveBeenCalledWith('node-1', 'draft');
  });

  it('resolves a maskId against a vector-node reference and hands the rasterised plane to the run', async () => {
    const vectorTransform = { x: -15, y: 8, scaleX: 1, scaleY: 1, rotation: -0.2 };
    const vectorNode = makeVectorNode({ id: 'v1', transform2d: vectorTransform }) as VectorNode;
    const ref = {
      id: 'ref-1',
      nodeId: 'v1',
      featherPx: 4,
      expand: 0,
      invert: false,
    };
    const consumerTransform = { x: 30, y: -12, scaleX: 2, scaleY: 1, rotation: 0.3 };
    const nodeRef = {
      current: makeNode({
        sourceSize: [800, 400],
        transform2d: consumerTransform,
        modifiers: [
          {
            id: 'm1',
            type: 'gaussian_blur',
            enabled: true,
            params: { radius: 8 },
            maskId: 'ref-1',
          },
        ],
      }),
    };
    const plane = new Uint8Array(100 * 50);
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn((id: string) => (id === 'ref-1' ? ref : undefined)),
      // getNode must resolve BOTH the cooking node and the referenced vector node.
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 'v1' ? vectorNode : undefined,
      ),
      rasterizeVectorMask: vi.fn(() => plane),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.rasterizeVectorMask).toHaveBeenCalledWith(
      vectorNode.paths,
      vectorNode.fillRule,
      ref,
      vectorTransform, // the SHAPE's current transform2d — the mask reads its composited position
      [800, 400], // documentSize — the vector raster's frame
      consumerTransform, // the consumer's CURRENT transform2d — document-pinned, never a snapshot
      [800, 400], // the CONSUMING node's own sourceSize, not the vector node's
      100,
      50,
      1 / 8,
    );
    const [, , runModifiers] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runModifiers[0].mask).toBe(plane);
  });

  it('a vector ref whose target node has vanished resolves to no mask (last-line-of-defence)', async () => {
    const ref = {
      id: 'ref-1',
      nodeId: 'gone',
      featherPx: 0,
      expand: 0,
      invert: false,
    };
    const nodeRef = {
      current: makeNode({
        modifiers: [
          { id: 'm1', type: 'gaussian_blur', enabled: true, params: {}, maskId: 'ref-1' },
        ],
      }),
    };
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn(() => ref),
      getNode: vi.fn((id: string) => (id === 'node-1' ? nodeRef.current : undefined)),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.rasterizeVectorMask).not.toHaveBeenCalled();
    const [, , runModifiers] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runModifiers[0].mask).toBeUndefined();
  });
});

describe('cookNode — text-node mask targets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCookErrorBurst();
  });

  const ref = { id: 'ref-1', nodeId: 't1', featherPx: 2, expand: 1, invert: true };
  const textGeometry: TextGeometry = {
    paths: [
      {
        closed: true,
        anchors: [{ point: { x: 0, y: 0 }, handleOut: { x: 1, y: 1 } }, { point: { x: 10, y: 0 } }],
      },
    ],
    lines: [],
    ascent: 0,
    descent: 0,
    bounds: null,
  };
  const consumer = () =>
    makeNode({
      transform2d: { x: 3, y: 4, scaleX: 1, scaleY: 1, rotation: 0 },
      modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: {}, maskId: 'ref-1' }],
    });

  it('rasterises the text target through rasterizeVectorMask: translated paths, nonzero', async () => {
    const textTransform = { x: -5, y: 2, scaleX: 1, scaleY: 1, rotation: 0.1 };
    const text = makeTextNode({
      id: 't1',
      position: { x: 100, y: 200 },
      transform2d: textTransform,
    });
    const nodeRef = { current: consumer() };
    const plane = new Uint8Array(100 * 50);
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn((id: string) => (id === 'ref-1' ? ref : undefined)),
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 't1' ? text : undefined,
      ),
      getTextGeometry: vi.fn(async () => textGeometry),
      rasterizeVectorMask: vi.fn(() => plane),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.getTextGeometry).toHaveBeenCalledWith(text);
    expect(deps.rasterizeVectorMask).toHaveBeenCalledWith(
      [
        {
          closed: true,
          anchors: [
            { point: { x: 100, y: 200 }, handleOut: { x: 101, y: 201 } },
            { point: { x: 110, y: 200 } },
          ],
        },
      ],
      'nonzero',
      ref,
      textTransform,
      [800, 400],
      nodeRef.current.transform2d,
      [800, 400],
      100,
      50,
      1 / 8,
    );
    const [, , runModifiers] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runModifiers[0].mask).toBe(plane);
  });

  it('a ref to a deleted node resolves to no mask and asks for no geometry', async () => {
    const nodeRef = { current: consumer() };
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn(() => ref),
      getNode: vi.fn((id: string) => (id === 'node-1' ? nodeRef.current : undefined)),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.getTextGeometry).not.toHaveBeenCalled();
    expect(deps.rasterizeVectorMask).not.toHaveBeenCalled();
    const [, , runModifiers] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runModifiers[0].mask).toBeUndefined();
  });

  it('a geometry rejection for the mask target is a cook failure: dirty stays, nothing cached', async () => {
    const text = makeTextNode({ id: 't1' });
    const nodeRef = { current: consumer() };
    const deps = makeDeps(nodeRef, {
      getVectorMaskRef: vi.fn(() => ref),
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 't1' ? text : undefined,
      ),
      getTextGeometry: vi.fn(async () => {
        throw new Error('FontNotFound: Nope');
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.runPython).not.toHaveBeenCalled();
    expect(deps.setCache).not.toHaveBeenCalled();
    expect(deps.clearDirty).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('cookNodeFullRes prefetches and rasterises the same way (factor 1)', async () => {
    const text = makeTextNode({ id: 't1', position: { x: 7, y: 9 } });
    const nodeRef = { current: consumer() };
    const rasterizeVectorMask = vi.fn(() => new Uint8Array(800 * 400));
    const deps: FullResCookDeps = {
      getNode: vi.fn((id: string) =>
        id === 'node-1' ? nodeRef.current : id === 't1' ? text : undefined,
      ),
      getSource: vi.fn(() => fakeBitmap()),
      getOps: vi.fn(() => opsFixture),
      getDocumentSize: vi.fn(() => [800, 400] as [number, number]),
      getVectorMaskRef: vi.fn(() => ref),
      rasterizeVectorMask,
      rasterizeVector: vi.fn(),
      getTextGeometry: vi.fn(async () => textGeometry),
      rasterizeText: vi.fn(),
      downscale: vi.fn((_s: ImageBitmap, w: number, h: number) => new Uint8Array(w * h * 4)),
      runPython: vi.fn(async (w: number, h: number) => new Uint8Array(w * h * 4)),
      encode: vi.fn(async () => fakeBitmap()),
    };

    await cookNodeFullRes('node-1', deps);

    expect(deps.getTextGeometry).toHaveBeenCalledWith(text);
    const call = (rasterizeVectorMask.mock.calls[0] as unknown[]) ?? [];
    expect(call[0]).toEqual([
      {
        closed: true,
        anchors: [
          { point: { x: 7, y: 9 }, handleOut: { x: 8, y: 10 } },
          { point: { x: 17, y: 9 } },
        ],
      },
    ]);
    expect(call[1]).toBe('nonzero');
    expect(call[9]).toBe(1);
  });
});

describe('partitionRuns', () => {
  it('keeps one run for an all-python stack (the common case today)', () => {
    const built = buildCookModifiers(
      [
        { id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 4 } },
        { id: 'm2', type: 'levels', enabled: true, params: { black: 0 } },
      ],
      1,
      opsFixture,
    );
    const runs = partitionRuns(built);
    expect(runs).toHaveLength(1);
    expect(runs[0].backend).toBe('python');
    expect(runs[0].modifiers).toHaveLength(2);
  });

  it('splits into maximal same-backend runs', () => {
    const runs = partitionRuns([
      { type: 'a', backend: 'python', params: {} },
      { type: 'b', backend: 'python', params: {} },
      { type: 'c', backend: 'rust', params: {} },
      { type: 'd', backend: 'python', params: {} },
    ]);
    expect(runs.map((r) => [r.backend, r.modifiers.length])).toEqual([
      ['python', 2],
      ['rust', 1],
      ['python', 1],
    ]);
  });
});

describe('cookNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCookErrorBurst();
    useLastCookStore.setState({ last: null });
  });

  it('a successful cook publishes once with the node label and level', async () => {
    const nodeRef = { current: makeNode({ label: 'Portrait', sourceSize: [800, 400] }) };
    const deps = makeDeps(nodeRef);
    const seen: unknown[] = [];
    const unsubscribe = useLastCookStore.subscribe((state) => seen.push(state.last));

    await cookNode('node-1', 'working', deps);
    unsubscribe();

    expect(seen).toHaveLength(1);
    expect(useLastCookStore.getState().last).toMatchObject({
      nodeLabel: 'Portrait',
      level: 'working',
      width: 400,
      height: 200,
    });
    expect(useLastCookStore.getState().last?.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('a failing cook publishes nothing and leaves the previous value in place', async () => {
    const previous = {
      nodeLabel: 'Earlier',
      level: 'draft' as const,
      totalMs: 5,
      sidecarMs: 3,
      width: 10,
      height: 10,
    };
    useLastCookStore.setState({ last: previous });
    const nodeRef = {
      current: makeNode({
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }),
    };
    const deps = makeDeps(nodeRef, {
      runPython: vi.fn(async () => {
        throw new Error('sidecar down');
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(useLastCookStore.getState().last).toBe(previous);
  });

  it('zero enabled modifiers: skips the sidecar entirely', async () => {
    const nodeRef = { current: makeNode({ modifiers: [] }) };
    const deps = makeDeps(nodeRef);

    await cookNode('node-1', 'draft', deps);

    expect(deps.runPython).not.toHaveBeenCalled();
    expect(deps.setCache).toHaveBeenCalledWith('node-1', 'draft', expect.anything());
    expect(deps.clearDirty).toHaveBeenCalledWith('node-1', 'draft');
  });

  it('enabled modifiers: runs the python op once, scaling spatial params, and clears dirty on success', async () => {
    const nodeRef = {
      current: makeNode({
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }),
    };
    const deps = makeDeps(nodeRef);

    await cookNode('node-1', 'draft', deps);

    expect(deps.runPython).toHaveBeenCalledTimes(1);
    const [, , modifiers] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    // draft factor 1/8: radius 8 -> 1
    expect(modifiers).toEqual([
      { type: 'gaussian_blur', backend: 'python', params: { radius: 1 } },
    ]);
    expect(deps.setCache).toHaveBeenCalledOnce();
    expect(deps.clearDirty).toHaveBeenCalledOnce();
  });

  it('does not clear dirty when the node was re-dirtied (modifiers reference changed) during the cook', async () => {
    const originalModifiers: Modifier[] = [
      { id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } },
    ];
    const nodeRef = { current: makeNode({ modifiers: originalModifiers }) };

    const deps = makeDeps(nodeRef, {
      // Simulate a param edit landing *during* the cook: by the time
      // cookNode re-reads the node after the sidecar responds, its
      // `modifiers` array is a new reference (a real store mutation).
      runPython: vi.fn(async (w: number, h: number) => {
        nodeRef.current = {
          ...nodeRef.current,
          modifiers: [{ ...originalModifiers[0], params: { radius: 99 } }],
        };
        return new Uint8Array(w * h * 4);
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.setCache).toHaveBeenCalledOnce(); // stale-but-newer-than-nothing result still written
    expect(deps.clearDirty).not.toHaveBeenCalled(); // dirty stays set for the follow-up cook
  });

  it('source missing: no-op, does not throw', async () => {
    const nodeRef = { current: makeNode() };
    const deps = makeDeps(nodeRef, { getSource: vi.fn(() => undefined) });

    await cookNode('node-1', 'draft', deps);

    expect(deps.setCache).not.toHaveBeenCalled();
    expect(deps.clearDirty).not.toHaveBeenCalled();
  });

  it('failure: keeps dirty set, does not touch the cache, toasts once per burst', async () => {
    const nodeRef = {
      current: makeNode({
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }),
    };
    const deps = makeDeps(nodeRef, {
      runPython: vi.fn(async () => {
        throw new Error('sidecar down');
      }),
    });

    await cookNode('node-1', 'draft', deps);
    await cookNode('node-1', 'draft', deps);

    expect(deps.setCache).not.toHaveBeenCalled();
    expect(deps.clearDirty).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('resetCookErrorBurst allows a fresh toast for a new burst', async () => {
    const nodeRef = {
      current: makeNode({
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }),
    };
    const deps = makeDeps(nodeRef, {
      runPython: vi.fn(async () => {
        throw new Error('sidecar down');
      }),
    });

    await cookNode('node-1', 'draft', deps);
    resetCookErrorBurst();
    await cookNode('node-1', 'draft', deps);

    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});

describe('cookNode — vector nodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCookErrorBurst();
  });

  it('rasterises the node paths (not getSource/downscale) at documentSize x factor', async () => {
    const nodeRef = { current: makeVectorNode() };
    const deps = makeDeps(nodeRef);

    await cookNode('node-1', 'draft', deps);

    expect(deps.getSource).not.toHaveBeenCalled();
    expect(deps.downscale).not.toHaveBeenCalled();
    expect(deps.rasterizeVector).toHaveBeenCalledWith(
      (nodeRef.current as unknown as VectorNode).paths,
      'nonzero',
      100, // documentSize [800,400] x draft factor 1/8
      50,
      1 / 8,
    );
    expect(deps.setCache).toHaveBeenCalledWith('node-1', 'draft', expect.anything());
    expect(deps.clearDirty).toHaveBeenCalledWith('node-1', 'draft');
  });

  it('rasterizeVector throwing is caught like any other cook failure: dirty stays set, one toast', async () => {
    const nodeRef = { current: makeVectorNode() };
    const deps = makeDeps(nodeRef, {
      rasterizeVector: vi.fn(() => {
        throw new Error('bad path');
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.setCache).not.toHaveBeenCalled();
    expect(deps.clearDirty).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('runs enabled modifiers over the rasterised paths, same as a pixel node', async () => {
    const nodeRef = {
      current: makeVectorNode({
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }),
    };
    const deps = makeDeps(nodeRef);

    await cookNode('node-1', 'draft', deps);

    expect(deps.runPython).toHaveBeenCalledTimes(1);
    const [, , modifiers] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(modifiers).toEqual([
      { type: 'gaussian_blur', backend: 'python', params: { radius: 1 } },
    ]);
  });
});

describe('cookNode — text nodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCookErrorBurst();
  });

  it('cooks at documentSize x factor from the geometry + raster stubs', async () => {
    const node = makeTextNode();
    const nodeRef = { current: node as SceneNode };
    const deps = makeDeps(nodeRef);

    await cookNode('node-1', 'draft', deps);

    expect(deps.getSource).not.toHaveBeenCalled();
    expect(deps.getTextGeometry).toHaveBeenCalledWith(node);
    expect(deps.rasterizeText).toHaveBeenCalledWith(node, emptyGeometry, 100, 50, 1 / 8);
    expect(deps.setCache).toHaveBeenCalledWith('node-1', 'draft', expect.anything());
    expect(deps.clearDirty).toHaveBeenCalledWith('node-1', 'draft');
  });

  it('a geometry rejection is a cook failure: dirty stays, cache untouched, one toast per burst', async () => {
    const nodeRef = { current: makeTextNode() as SceneNode };
    const deps = makeDeps(nodeRef, {
      getTextGeometry: vi.fn(async () => {
        throw new Error('FontNotFound: Nope');
      }),
    });

    await cookNode('node-1', 'draft', deps);
    await cookNode('node-1', 'working', deps);

    expect(deps.rasterizeText).not.toHaveBeenCalled();
    expect(deps.setCache).not.toHaveBeenCalled();
    expect(deps.clearDirty).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('runs enabled modifiers over the text raster', async () => {
    const nodeRef = {
      current: makeTextNode({
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }) as SceneNode,
    };
    const raster = new Uint8Array(100 * 50 * 4).fill(7);
    const deps = makeDeps(nodeRef, { rasterizeText: vi.fn(() => raster) });

    await cookNode('node-1', 'draft', deps);

    expect(deps.runPython).toHaveBeenCalledTimes(1);
    const [, , modifiers, payload] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(modifiers).toEqual([
      { type: 'gaussian_blur', backend: 'python', params: { radius: 1 } },
    ]);
    expect(payload).toBe(raster);
  });

  it('race guard: a dirty-flag flip (new node object, same inputs) still clears dirty', async () => {
    const nodeRef = { current: makeTextNode() as SceneNode };
    const deps = makeDeps(nodeRef, {
      getTextGeometry: vi.fn(async () => {
        // markDirty replaces the node object but changes no cook input.
        nodeRef.current = { ...nodeRef.current, dirty: { draft: true, working: true } };
        return emptyGeometry;
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.clearDirty).toHaveBeenCalledWith('node-1', 'draft');
  });

  it('race guard: a cook-input edit mid-cook writes the bitmap but leaves dirty set', async () => {
    const nodeRef = { current: makeTextNode() as SceneNode };
    const deps = makeDeps(nodeRef, {
      getTextGeometry: vi.fn(async () => {
        nodeRef.current = { ...(nodeRef.current as TextNode), content: 'CHANGED' } as TextNode;
        return emptyGeometry;
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.setCache).toHaveBeenCalledTimes(1);
    expect(deps.clearDirty).not.toHaveBeenCalled();
  });

  it('race guard: a position edit (raster-time input, not geometry) also leaves dirty set', async () => {
    const nodeRef = { current: makeTextNode() as SceneNode };
    const deps = makeDeps(nodeRef, {
      encode: vi.fn(async () => {
        nodeRef.current = {
          ...(nodeRef.current as TextNode),
          position: { x: 99, y: 99 },
        } as TextNode;
        return fakeBitmap();
      }),
    });

    await cookNode('node-1', 'draft', deps);

    expect(deps.clearDirty).not.toHaveBeenCalled();
  });

  it('cooks full-res at documentSize, factor 1', async () => {
    const node = makeTextNode();
    const deps = {
      ...makeDeps({ current: node as SceneNode }),
    } as unknown as FullResCookDeps;

    await cookNodeFullRes('node-1', deps);

    expect(deps.rasterizeText).toHaveBeenCalledWith(node, emptyGeometry, 800, 400, 1);
    expect(deps.encode).toHaveBeenCalledWith(expect.any(Uint8Array), 800, 400);
  });
});

describe('cookNodeFullRes', () => {
  function makeFullResDeps(
    nodeRef: { current: SceneNode },
    overrides: Partial<FullResCookDeps> = {},
  ): FullResCookDeps {
    return {
      getNode: vi.fn((id: string) => (nodeRef.current.id === id ? nodeRef.current : undefined)),
      getSource: vi.fn(() => fakeBitmap()),
      getOps: vi.fn(() => opsFixture),
      getDocumentSize: vi.fn(() => [800, 400] as [number, number]),
      getVectorMaskRef: vi.fn(() => undefined),
      rasterizeVectorMask: vi.fn(
        (
          _paths,
          _fillRule,
          _ref,
          _vecTransform,
          _docSize,
          _consumerTransform,
          _consumerSourceSize,
          w: number,
          h: number,
          _factor: number,
        ) => new Uint8Array(w * h),
      ),
      rasterizeVector: vi.fn(
        (_paths, _fillRule, w: number, h: number, _factor: number) => new Uint8Array(w * h * 4),
      ),
      getTextGeometry: vi.fn(async () => emptyGeometry),
      rasterizeText: vi.fn(
        (_node, _geometry, w: number, h: number, _factor: number) => new Uint8Array(w * h * 4),
      ),
      downscale: vi.fn((_src: ImageBitmap, w: number, h: number) => new Uint8Array(w * h * 4)),
      runPython: vi.fn(async (w: number, h: number) => new Uint8Array(w * h * 4)),
      encode: vi.fn(async () => fakeBitmap()),
      ...overrides,
    };
  }

  it("publishes a 'baked' cook on success and nothing on failure", async () => {
    useLastCookStore.setState({ last: null });
    const nodeRef = { current: makeNode({ label: 'Plate', sourceSize: [800, 400] }) };

    await cookNodeFullRes('node-1', makeFullResDeps(nodeRef));
    expect(useLastCookStore.getState().last).toMatchObject({
      nodeLabel: 'Plate',
      level: 'baked',
      width: 800,
      height: 400,
    });

    const before = useLastCookStore.getState().last;
    await expect(
      cookNodeFullRes(
        'node-1',
        makeFullResDeps(nodeRef, {
          encode: vi.fn(async () => {
            throw new Error('encode failed');
          }),
        }),
      ),
    ).rejects.toThrow('encode failed');
    expect(useLastCookStore.getState().last).toBe(before);
  });

  it("cooks at the node's own sourceSize (factor 1) — no downscale", async () => {
    const nodeRef = { current: makeNode({ sourceSize: [800, 400] }) };
    const deps = makeFullResDeps(nodeRef);

    await cookNodeFullRes('node-1', deps);

    expect(deps.downscale).toHaveBeenCalledWith(expect.anything(), 800, 400);
  });

  it('scales spatial modifier params by factor 1 (unscaled — full res is the reference size)', async () => {
    const nodeRef = {
      current: makeNode({
        sourceSize: [800, 400],
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }),
    };
    const deps = makeFullResDeps(nodeRef);

    await cookNodeFullRes('node-1', deps);

    const [width, height, modifiers] = (deps.runPython as ReturnType<typeof vi.fn>).mock.calls[0];
    expect([width, height]).toEqual([800, 400]);
    expect(modifiers).toEqual([
      { type: 'gaussian_blur', backend: 'python', params: { radius: 8 } },
    ]);
  });

  it('never writes any cache or dirty flag — it has no such deps to call', async () => {
    const nodeRef = { current: makeNode() };
    const deps = makeFullResDeps(nodeRef);

    const bitmap = await cookNodeFullRes('node-1', deps);

    expect(bitmap).toBeDefined();
    expect(deps).not.toHaveProperty('setCache');
    expect(deps).not.toHaveProperty('clearDirty');
  });

  it('throws (does not swallow) when the source is missing — never falls back to a lower-res bitmap', async () => {
    const nodeRef = { current: makeNode() };
    const deps = makeFullResDeps(nodeRef, { getSource: vi.fn(() => undefined) });

    await expect(cookNodeFullRes('node-1', deps)).rejects.toThrow(/no decoded source/);
    expect(deps.downscale).not.toHaveBeenCalled();
  });

  it('throws when the sidecar op run fails — export must abort, not substitute a draft bitmap', async () => {
    const nodeRef = {
      current: makeNode({
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 8 } }],
      }),
    };
    const deps = makeFullResDeps(nodeRef, {
      runPython: vi.fn(async () => {
        throw new Error('sidecar down');
      }),
    });

    await expect(cookNodeFullRes('node-1', deps)).rejects.toThrow('sidecar down');
    expect(deps.encode).not.toHaveBeenCalled();
  });

  it('throws for a node type that produces no source pixels', async () => {
    const nodeRef = { current: { ...makeNode(), type: 'camera' } as unknown as SceneNode };
    const deps = makeFullResDeps(nodeRef);

    await expect(cookNodeFullRes('node-1', deps)).rejects.toThrow(/not a cookable node type/);
  });

  it('cooks a vector node full-res via rasterizeVector at documentSize (export with vectors, dogfood 2026-07-06)', async () => {
    const nodeRef = { current: makeVectorNode() };
    const deps = makeFullResDeps(nodeRef);

    await cookNodeFullRes('node-1', deps);

    // documentSize (800×400) at factor 1 — a vector node has no sourceSize.
    expect(deps.rasterizeVector).toHaveBeenCalledWith(
      (nodeRef.current as VectorNode).paths,
      'nonzero',
      800,
      400,
      1,
    );
    expect(deps.downscale).not.toHaveBeenCalled();
    expect(deps.encode).toHaveBeenCalledWith(expect.any(Uint8Array), 800, 400);
  });
});

describe('cookNode — prefix cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCookErrorBurst();
  });

  /** Deterministic, order-sensitive fake op: folds each modifier into every byte. */
  function fakeOp(bytes: Uint8Array, mods: CookModifier[]): Uint8Array {
    const out = new Uint8Array(bytes);
    for (const m of mods) {
      const delta = (JSON.stringify(m.params).length * 7 + Number(m.params.black ?? 0)) & 255;
      for (let i = 0; i < out.length; i++) out[i] = (out[i] * 31 + delta + 1) & 255;
    }
    return out;
  }
  /** What every stub source rasteriser returns: recognisably "source pixels". */
  const sourcePattern = (w: number, h: number) =>
    Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 13 + 5) & 255);

  const levelsMod = (i: number, black: number): Modifier => ({
    id: `m${i}`,
    type: 'levels',
    enabled: true,
    params: { black },
  });
  /** `levels` stack: modifier i has black = blacks[i]. */
  const stackOf = (...blacks: number[]): Modifier[] => blacks.map((b, i) => levelsMod(i, b));

  interface Call {
    modifiers: CookModifier[];
    payload: Uint8Array;
  }
  interface Harness {
    nodeRef: { current: SceneNode };
    deps: CookDeps;
    calls: Call[];
    encoded: Uint8Array[];
    /** Forget calls so far (and mock counts) — assertions then see only what follows. */
    reset: () => void;
  }

  function harness(node: SceneNode, depsOver: Partial<CookDeps> = {}): Harness {
    const nodeRef = { current: node };
    const calls: Call[] = [];
    const encoded: Uint8Array[] = [];
    const deps = makeDeps(nodeRef, {
      downscale: vi.fn((_s: ImageBitmap, w: number, h: number) => sourcePattern(w, h)),
      rasterizeVector: vi.fn((_p, _f, w: number, h: number) => sourcePattern(w, h)),
      rasterizeText: vi.fn((_n, _g, w: number, h: number) => sourcePattern(w, h)),
      runPython: vi.fn(
        async (_w: number, _h: number, mods: CookModifier[], payload: Uint8Array) => {
          calls.push({ modifiers: mods, payload: payload.slice() });
          return fakeOp(payload, mods);
        },
      ),
      encode: vi.fn(async (bytes: Uint8Array) => {
        encoded.push(bytes.slice());
        return fakeBitmap();
      }),
      ...depsOver,
    });
    return {
      nodeRef,
      deps,
      calls,
      encoded,
      reset: () => {
        calls.length = 0;
        encoded.length = 0;
        for (const fn of [
          deps.downscale,
          deps.rasterizeVector,
          deps.rasterizeText,
          deps.getTextGeometry,
        ]) {
          (fn as ReturnType<typeof vi.fn>).mockClear();
        }
        vi.mocked(deps.setPrefix).mockClear();
        vi.mocked(deps.clearDirty).mockClear();
        vi.mocked(deps.rasterizeVectorMask).mockClear();
        vi.mocked(deps.setLastStack).mockClear();
      },
    };
  }

  const pixelHarness = (modifiers = stackOf(1, 2, 3, 4), over: Partial<CookDeps> = {}) =>
    harness(makeNode({ modifiers }), over);

  const blacks = (call: Call) => call.modifiers.map((m) => m.params.black);

  /** Edit one modifier's `black` in place of the node's stack (a new array, like the store). */
  function setBlack(h: Harness, idx: number, black: number): void {
    const cur = h.nodeRef.current;
    h.nodeRef.current = {
      ...cur,
      modifiers: cur.modifiers.map((m, i) => (i === idx ? { ...m, params: { black } } : m)),
    } as SceneNode;
  }

  /** Full cook -> splitting cook (snapshots prefix [0,idx)) -> hot cook. Leaves the harness reset. */
  async function warmUp(h: Harness, idx = 2, level: CookLevel = 'draft'): Promise<void> {
    await cookNode('node-1', level, h.deps);
    setBlack(h, idx, 50);
    await cookNode('node-1', level, h.deps);
    setBlack(h, idx, 51);
    await cookNode('node-1', level, h.deps);
    h.reset();
  }

  /** A full cook from source pixels: the source rasteriser ran and the first run got source bytes. */
  function expectFullCook(h: Harness, rasterizer: keyof CookDeps = 'downscale'): void {
    expect(h.deps[rasterizer]).toHaveBeenCalledTimes(1);
    expect(h.calls[0].payload).toEqual(sourcePattern(100, 50));
    expect(h.calls[0].modifiers[0].params.black).toBe(
      (h.nodeRef.current.modifiers.find((m) => m.enabled)?.params as { black: number }).black,
    );
  }

  describe('scrubbing op N of M', () => {
    it('first cook is a full cook; the second splits once; then one call covers only N..M', async () => {
      const h = pixelHarness(); // M = 4, N = 2

      await cookNode('node-1', 'draft', h.deps);
      expect(h.calls.map(blacks)).toEqual([[1, 2, 3, 4]]); // no history -> no split
      expect(h.deps.setPrefix).not.toHaveBeenCalled();

      setBlack(h, 2, 50);
      await cookNode('node-1', 'draft', h.deps);
      // the one-off split: [0,N) then [N,M), the prefix snapshotted between
      expect(h.calls.slice(1).map(blacks)).toEqual([
        [1, 2],
        [50, 4],
      ]);
      expect(h.deps.setPrefix).toHaveBeenCalledTimes(1);

      h.reset();
      setBlack(h, 2, 51);
      await cookNode('node-1', 'draft', h.deps);

      expect(h.calls).toHaveLength(1);
      expect(blacks(h.calls[0])).toEqual([51, 4]);
      const stored = h.deps.getPrefix('node-1', 'draft');
      expect(stored?.descriptor.modifiers).toHaveLength(2);
      expect(h.calls[0].payload).toEqual(stored?.bytes);
      expect(h.deps.downscale).not.toHaveBeenCalled();
      expect(h.deps.rasterizeVector).not.toHaveBeenCalled();
      expect(h.deps.rasterizeText).not.toHaveBeenCalled();
      expect(h.deps.clearDirty).toHaveBeenCalled();
    });

    it('repeated scrubs of the same op keep hitting and keep the stored prefix as it was', async () => {
      const h = pixelHarness();
      await warmUp(h);
      const before = h.deps.getPrefix('node-1', 'draft');

      for (const v of [60, 61, 62]) {
        setBlack(h, 2, v);
        await cookNode('node-1', 'draft', h.deps);
      }

      expect(h.calls.map(blacks)).toEqual([
        [60, 4],
        [61, 4],
        [62, 4],
      ]);
      expect(h.deps.downscale).not.toHaveBeenCalled();
      expect(h.deps.getPrefix('node-1', 'draft')).toBe(before);
      expect(h.deps.setPrefix).not.toHaveBeenCalled();
    });

    it('moving to a later op extends the prefix; the earlier source work is not repeated', async () => {
      const h = pixelHarness();
      await warmUp(h); // prefix covers [0,2)
      setBlack(h, 3, 70); // edit op 3: hit at 2, split at 3
      await cookNode('node-1', 'draft', h.deps);

      expect(h.calls.map(blacks)).toEqual([[51], [70]]); // m2 (unchanged since the warm-up), then m3
      expect(h.deps.downscale).not.toHaveBeenCalled();
      expect(h.deps.getPrefix('node-1', 'draft')?.descriptor.modifiers).toHaveLength(3);
    });

    it('a cook whose stack is wholly inside the stored prefix reuses the bytes without a sidecar call', async () => {
      const h = pixelHarness();
      await warmUp(h); // prefix covers [0,2); stack of 4
      // Drop the last two modifiers: the whole stack is now exactly the prefix.
      h.nodeRef.current = {
        ...h.nodeRef.current,
        modifiers: h.nodeRef.current.modifiers.slice(0, 2),
      } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);

      expect(h.calls).toHaveLength(0);
      expect(h.deps.downscale).not.toHaveBeenCalled();
      expect(h.encoded[0]).toEqual(h.deps.getPrefix('node-1', 'draft')?.bytes);
    });
  });

  describe('purity', () => {
    it('hot-cache result is byte-identical to a cold cook of the same stack', async () => {
      const hot = pixelHarness();
      await warmUp(hot);
      setBlack(hot, 2, 99);
      await cookNode('node-1', 'draft', hot.deps);
      expect(hot.deps.getPrefix('node-1', 'draft')).toBeDefined();
      expect(hot.calls).toHaveLength(1); // proves this one really was a hit

      const cold = pixelHarness(hot.nodeRef.current.modifiers);
      await cookNode('node-1', 'draft', cold.deps);

      expect(hot.encoded[0]).toEqual(cold.encoded[0]);
    });

    it('the stored snapshot is a copy: the next run cannot alter it', async () => {
      const h = pixelHarness(stackOf(1, 2, 3, 4), {
        runPython: vi.fn(async (_w, _h, mods: CookModifier[], payload: Uint8Array) => {
          const out = fakeOp(payload, mods);
          payload.fill(0); // a transport that reuses/zeroes its input buffer
          return out;
        }),
      });
      await cookNode('node-1', 'draft', h.deps);
      setBlack(h, 2, 50);
      await cookNode('node-1', 'draft', h.deps);

      const stored = h.deps.getPrefix('node-1', 'draft');
      expect(stored?.bytes.some((b) => b !== 0)).toBe(true);
      // ...and a hit then hands on a copy, leaving the stored buffer intact.
      const snapshot = stored?.bytes.slice();
      setBlack(h, 2, 51);
      await cookNode('node-1', 'draft', h.deps);
      expect(h.deps.getPrefix('node-1', 'draft')?.bytes).toEqual(snapshot);
    });
  });

  describe('falls back to a full cook', () => {
    it('editing op 0', async () => {
      const h = pixelHarness();
      await warmUp(h);
      setBlack(h, 0, 9);
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h);
    });

    it('reordering', async () => {
      const h = pixelHarness();
      await warmUp(h);
      const [a, b, ...rest] = h.nodeRef.current.modifiers;
      h.nodeRef.current = { ...h.nodeRef.current, modifiers: [b, a, ...rest] } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h);
    });

    it('toggling an op inside the prefix', async () => {
      const h = pixelHarness();
      await warmUp(h); // prefix [0,2)
      const mods = h.nodeRef.current.modifiers;
      h.nodeRef.current = {
        ...h.nodeRef.current,
        modifiers: mods.map((m, i) => (i === 1 ? { ...m, enabled: false } : m)),
      } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h);
    });

    it('toggling a previously-disabled op back on inside the prefix', async () => {
      const mods = stackOf(1, 2, 3, 4, 5).map((m, i) => (i === 1 ? { ...m, enabled: false } : m));
      const h = pixelHarness(mods);
      await warmUp(h, 3); // enabled stack [m0, m2, m3, m4]; prefix covers [m0, m2]
      expect(h.deps.getPrefix('node-1', 'draft')?.descriptor.modifiers).toHaveLength(2);
      h.nodeRef.current = {
        ...h.nodeRef.current,
        modifiers: h.nodeRef.current.modifiers.map((m) => ({ ...m, enabled: true })),
      } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h);
    });

    it('toggling an op AFTER the prefix is not a fallback', async () => {
      const h = pixelHarness();
      await warmUp(h); // prefix covers [m0, m1]
      h.nodeRef.current = {
        ...h.nodeRef.current,
        modifiers: h.nodeRef.current.modifiers.map((m, i) =>
          i === 3 ? { ...m, enabled: false } : m,
        ),
      } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);
      expect(h.deps.downscale).not.toHaveBeenCalled();
      expect(h.calls.map(blacks)).toEqual([[51]]);
    });

    it('replacing the source bitmap', async () => {
      let bitmap = fakeBitmap();
      const h = pixelHarness(stackOf(1, 2, 3, 4), { getSource: vi.fn(() => bitmap) });
      await warmUp(h);
      bitmap = fakeBitmap(); // sources.set replaces the object on any reload
      setBlack(h, 2, 52);
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h);
    });

    it('the source node changing size (a different cook target)', async () => {
      const h = pixelHarness();
      await warmUp(h);
      h.nodeRef.current = { ...h.nodeRef.current, sourceSize: [1600, 800] } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);
      expect(h.deps.downscale).toHaveBeenCalledWith(expect.anything(), 200, 100);
      expect(h.calls[0].payload).toEqual(sourcePattern(200, 100));
    });

    it('text content edits on a text node', async () => {
      const h = harness(makeTextNode({ modifiers: stackOf(1, 2, 3, 4) }) as SceneNode);
      await warmUp(h);
      expect(h.deps.getTextGeometry).not.toHaveBeenCalled(); // not even asked while hot
      h.nodeRef.current = { ...(h.nodeRef.current as TextNode), content: 'CHANGED' } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h, 'rasterizeText');
    });

    it('a text node scrub (not an edit of the text) still hits', async () => {
      const h = harness(makeTextNode({ modifiers: stackOf(1, 2, 3, 4) }) as SceneNode);
      await warmUp(h);
      setBlack(h, 2, 77);
      await cookNode('node-1', 'draft', h.deps);
      expect(h.calls.map(blacks)).toEqual([[77, 4]]);
      expect(h.deps.rasterizeText).not.toHaveBeenCalled();
    });

    it("editing a vector node's own paths", async () => {
      const h = harness(makeVectorNode({ modifiers: stackOf(1, 2, 3, 4) }));
      await warmUp(h);
      expect(h.deps.rasterizeVector).not.toHaveBeenCalled();
      const v = h.nodeRef.current as VectorNode;
      h.nodeRef.current = {
        ...v,
        paths: [{ closed: true, anchors: [{ point: { x: 3, y: 3 } }, { point: { x: 9, y: 9 } }] }],
      } as SceneNode;
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h, 'rasterizeVector');
    });

    it('the op registry arriving after a cook that ran with it missing', async () => {
      let ops: OpDescriptor[] = [];
      const h = pixelHarness(stackOf(1, 2, 3, 4), { getOps: vi.fn(() => ops) });
      await warmUp(h);
      ops = opsFixture; // list_ops answered: params may now scale differently
      setBlack(h, 2, 53);
      await cookNode('node-1', 'draft', h.deps);
      expectFullCook(h);
    });

    describe('masked prefix modifiers', () => {
      function maskedHarness(refOver: Record<string, unknown> = {}) {
        const world = {
          ref: { id: 'ref-1', nodeId: 'v1', featherPx: 0, expand: 0, invert: false, ...refOver },
          vec: makeVectorNode({ id: 'v1' }) as VectorNode,
        };
        const modifiers = stackOf(1, 2, 3, 4).map((m, i) =>
          i === 0 ? { ...m, maskId: 'ref-1' } : m,
        );
        const nodeRef = { current: makeNode({ modifiers }) };
        // harness() builds its own nodeRef; share ours via getNode below.
        const h = harness(nodeRef.current, {
          getVectorMaskRef: vi.fn((id: string) => (id === 'ref-1' ? world.ref : undefined)),
          getNode: vi.fn((id: string) =>
            id === 'node-1' ? h.nodeRef.current : id === 'v1' ? world.vec : undefined,
          ),
        });
        return { h, world };
      }

      it("changing the mask ref's feather on a prefix modifier", async () => {
        const { h, world } = maskedHarness();
        await warmUp(h);
        world.ref = { ...world.ref, featherPx: 6 };
        setBlack(h, 2, 54);
        await cookNode('node-1', 'draft', h.deps);
        expectFullCook(h);
      });

      it("moving the referenced vector's anchors", async () => {
        const { h, world } = maskedHarness();
        await warmUp(h);
        world.vec = {
          ...world.vec,
          paths: [
            { closed: true, anchors: [{ point: { x: 4, y: 4 } }, { point: { x: 8, y: 1 } }] },
          ],
        };
        setBlack(h, 2, 54);
        await cookNode('node-1', 'draft', h.deps);
        expectFullCook(h);
      });

      it('moving a consumer that has a document-pinned mask', async () => {
        const { h } = maskedHarness();
        await warmUp(h);
        h.nodeRef.current = {
          ...h.nodeRef.current,
          transform2d: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
        } as SceneNode;
        await cookNode('node-1', 'draft', h.deps);
        expectFullCook(h);
      });

      it('moving a consumer with a NODE-pinned mask does not invalidate the prefix', async () => {
        const { h } = maskedHarness({
          space: 'node',
          attachTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        });
        await warmUp(h);
        h.nodeRef.current = {
          ...h.nodeRef.current,
          transform2d: { x: 5, y: 5, scaleX: 1, scaleY: 1, rotation: 0 },
        } as SceneNode;
        setBlack(h, 2, 54);
        await cookNode('node-1', 'draft', h.deps);

        expect(h.calls.map(blacks)).toEqual([[54, 4]]);
        expect(h.deps.downscale).not.toHaveBeenCalled();
      });

      it('a hit rasterises only the masks of the modifiers it still runs', async () => {
        const { h } = maskedHarness(); // the mask is on modifier 0, inside the prefix
        await warmUp(h);
        setBlack(h, 2, 55);
        await cookNode('node-1', 'draft', h.deps);
        expect(h.deps.rasterizeVectorMask).not.toHaveBeenCalled();
        expect(h.calls).toHaveLength(1);
      });
    });
  });

  describe('levels', () => {
    it('DRAFT and WORKING keep independent entries and never reuse across levels', async () => {
      const h = pixelHarness();
      await warmUp(h, 2, 'draft');

      // WORKING has no entry yet: a full cook from source at its own size.
      setBlack(h, 2, 60);
      await cookNode('node-1', 'working', h.deps);
      expect(h.deps.downscale).toHaveBeenCalledWith(expect.anything(), 400, 200);
      expect(h.calls[0].payload).toEqual(sourcePattern(400, 200));

      await cookNode('node-1', 'working', h.deps); // lastStack now known, nothing to split
      setBlack(h, 2, 61);
      await cookNode('node-1', 'working', h.deps); // splits: prefix snapshotted
      setBlack(h, 2, 62);
      h.reset();
      await cookNode('node-1', 'working', h.deps);
      expect(h.calls).toHaveLength(1);
      expect(h.deps.downscale).not.toHaveBeenCalled();

      const draft = h.deps.getPrefix('node-1', 'draft');
      const working = h.deps.getPrefix('node-1', 'working');
      expect(draft?.descriptor).toMatchObject({ width: 100, height: 50 });
      expect(working?.descriptor).toMatchObject({ width: 400, height: 200 });

      // and DRAFT still hits on its own entry
      h.reset();
      setBlack(h, 2, 63);
      await cookNode('node-1', 'draft', h.deps);
      expect(h.deps.downscale).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(1);
    });
  });

  describe('failure and races', () => {
    it('a failed cook keeps the previous entry (and last stack)', async () => {
      const h = pixelHarness();
      await warmUp(h);
      const entry = h.deps.getPrefix('node-1', 'draft');
      const lastStack = h.deps.getLastStack('node-1', 'draft');
      const fails = vi.fn(async () => {
        throw new Error('sidecar down');
      });
      const failing = { ...h.deps, runPython: fails };

      h.reset();
      setBlack(h, 3, 80); // would extend the prefix, if it succeeded
      await cookNode('node-1', 'draft', failing);

      expect(h.deps.getPrefix('node-1', 'draft')).toBe(entry);
      expect(h.deps.getLastStack('node-1', 'draft')).toBe(lastStack);
      expect(h.deps.setPrefix).not.toHaveBeenCalled();
      expect(h.deps.clearDirty).not.toHaveBeenCalled();
    });

    it('a failure in the second group of a splitting cook stores no prefix at all', async () => {
      const h = pixelHarness();
      await cookNode('node-1', 'draft', h.deps);
      setBlack(h, 2, 50);
      let n = 0;
      const flaky = {
        ...h.deps,
        runPython: vi.fn(async (_w: number, _h: number, mods: CookModifier[], p: Uint8Array) => {
          if (++n === 2) throw new Error('second run failed');
          return fakeOp(p, mods);
        }),
      };
      await cookNode('node-1', 'draft', flaky);

      expect(n).toBe(2);
      expect(h.deps.getPrefix('node-1', 'draft')).toBeUndefined();
      expect(h.deps.setPrefix).not.toHaveBeenCalled();
    });

    it('an edit landing mid-cook stores nothing (the bytes may not match the descriptor)', async () => {
      const h = pixelHarness();
      await cookNode('node-1', 'draft', h.deps);
      setBlack(h, 2, 50);
      const racing = {
        ...h.deps,
        runPython: vi.fn(async (_w: number, _h: number, mods: CookModifier[], p: Uint8Array) => {
          setBlack(h, 3, 99); // a newer param edit while the run is in flight
          return fakeOp(p, mods);
        }),
      };
      h.reset();
      await cookNode('node-1', 'draft', racing);

      expect(h.deps.setPrefix).not.toHaveBeenCalled();
      expect(h.deps.setLastStack).not.toHaveBeenCalled();
      expect(h.deps.getPrefix('node-1', 'draft')).toBeUndefined();
      expect(h.deps.clearDirty).not.toHaveBeenCalled(); // the existing race guard, untouched
    });

    it('a mask-source edit mid-cook (modifiers untouched) stores nothing and leaves dirty set', async () => {
      const world = {
        ref: { id: 'ref-1', nodeId: 'v1', featherPx: 0, expand: 0, invert: false },
        vec: makeVectorNode({ id: 'v1' }) as VectorNode,
      };
      const modifiers = stackOf(1, 2).map((m, i) => (i === 0 ? { ...m, maskId: 'ref-1' } : m));
      const h = harness(makeNode({ modifiers }), {
        getVectorMaskRef: vi.fn(() => world.ref),
        getNode: vi.fn((id: string) =>
          id === 'node-1' ? h.nodeRef.current : id === 'v1' ? world.vec : undefined,
        ),
      });
      await cookNode('node-1', 'draft', h.deps);
      setBlack(h, 1, 50);
      const racing = {
        ...h.deps,
        runPython: vi.fn(async (_w: number, _h: number, mods: CookModifier[], p: Uint8Array) => {
          world.vec = { ...world.vec, paths: [] };
          return fakeOp(p, mods);
        }),
      };
      h.reset();
      await cookNode('node-1', 'draft', racing);

      expect(h.deps.setPrefix).not.toHaveBeenCalled();
      expect(h.deps.clearDirty).not.toHaveBeenCalled();
    });

    it('the last-cook readout still publishes exactly once per successful cook, hit or miss', async () => {
      useLastCookStore.setState({ last: null });
      const h = pixelHarness();
      const seen: unknown[] = [];
      const unsubscribe = useLastCookStore.subscribe((s) => seen.push(s.last));
      await warmUp(h);
      unsubscribe();
      expect(seen).toHaveLength(3);
    });
  });

  describe('buildCookModifiers 1:1 mapping (the index arithmetic depends on it)', () => {
    it('yields exactly one CookModifier per enabled modifier, in order, masks and unknown ops included', () => {
      const mods: Modifier[] = [
        { id: 'a', type: 'levels', enabled: true, params: { black: 1 }, maskId: 'm' },
        { id: 'b', type: 'levels', enabled: false, params: { black: 2 } },
        { id: 'c', type: 'no_such_op', enabled: true, params: {} },
        { id: 'd', type: 'gaussian_blur', enabled: true, params: { radius: 3 } },
      ];
      const built = buildCookModifiers(mods, 1 / 8, opsFixture, () => undefined);
      expect(built.map((m) => m.type)).toEqual(['levels', 'no_such_op', 'gaussian_blur']);
    });
  });
});
