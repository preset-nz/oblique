import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpDescriptor } from '@/sidecar/opsCache';
import type { Modifier, PixelNode, SceneNode } from '../scene/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { toast } from 'sonner';
import {
  buildCookModifiers,
  type CookDeps,
  computeTargetSize,
  cookNode,
  cookNodeFullRes,
  type FullResCookDeps,
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

/** A minimal CookDeps with all browser/sidecar edges stubbed; individual fields overridable per test. */
function makeDeps(nodeRef: { current: SceneNode }, overrides: Partial<CookDeps> = {}): CookDeps {
  return {
    getNode: vi.fn((id: string) => (nodeRef.current.id === id ? nodeRef.current : undefined)),
    getSource: vi.fn(() => fakeBitmap()),
    getOps: vi.fn(() => opsFixture),
    downscale: vi.fn((_src: ImageBitmap, w: number, h: number) => new Uint8Array(w * h * 4)),
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

describe('cookNodeFullRes', () => {
  function makeFullResDeps(
    nodeRef: { current: SceneNode },
    overrides: Partial<FullResCookDeps> = {},
  ): FullResCookDeps {
    return {
      getNode: vi.fn((id: string) => (nodeRef.current.id === id ? nodeRef.current : undefined)),
      getSource: vi.fn(() => fakeBitmap()),
      getOps: vi.fn(() => opsFixture),
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

  it('throws for a non-pixel node', async () => {
    const nodeRef = { current: { ...makeNode(), type: 'vector' } as unknown as SceneNode };
    const deps = makeFullResDeps(nodeRef);

    await expect(cookNodeFullRes('node-1', deps)).rejects.toThrow(/not a pixel node/);
  });
});
