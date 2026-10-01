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
    kerning: true,
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
  return {
    getNode: vi.fn((id: string) => (nodeRef.current.id === id ? nodeRef.current : undefined)),
    getSource: vi.fn(() => fakeBitmap()),
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
