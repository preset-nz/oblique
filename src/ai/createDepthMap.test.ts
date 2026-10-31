import { ModelDeclined } from '@preset.nz/app-kit/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionStore } from '@/scene/selection';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { PixelNode, Scene, VectorNode } from '@/scene/types';
import { type CreateDepthMapDeps, canCreateDepthMap, createDepthMap } from './createDepthMap';
import { ModelMissingError } from './sidecarSegment';

const clean = { draft: false, working: false };

const pixel = (id: string, over: Partial<PixelNode> = {}): PixelNode => ({
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
  dirty: clean,
  sourcePath: `/tmp/${id}.png`,
  sourceSize: [40, 30],
  ...over,
});

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

/** `ensure` is a fake `useModelGate().ensure`: the test says whether the model is there. */
function makeDeps(over: Partial<CreateDepthMapDeps> = {}) {
  const calls: string[] = [];
  const closed = vi.fn();
  const deps: CreateDepthMapDeps = {
    ensure: vi.fn(async (id: string) => {
      calls.push(`ensure:${id}`);
    }),
    readRaster: vi.fn(async () => {
      calls.push('raster');
      return { image: new Uint8Array(40 * 30 * 4), width: 40, height: 30 };
    }),
    depth: vi.fn(async (options) => {
      calls.push('depth');
      return { png: PNG, width: options.width, height: options.height, bits: options.bits ?? 8 };
    }),
    projectPath: () => '/art/piece.oblique',
    mkdir: vi.fn(async () => {
      calls.push('mkdir');
    }),
    writeFile: vi.fn(async () => {
      calls.push('write');
    }),
    keepPending: vi.fn(),
    decode: vi.fn(async () => ({ width: 40, height: 30, close: closed })),
    notify: vi.fn() as unknown as CreateDepthMapDeps['notify'],
    newId: () => 'file-id',
    ...over,
  };
  return { deps, calls, closed };
}

const ids = () => useSceneStore.getState().scene.nodes.map((n) => n.id);

function loadNodes(...nodes: PixelNode[]) {
  const scene: Scene = {
    id: 's',
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [40, 30],
  };
  useSceneStore.setState({ scene });
}

beforeEach(() => {
  sources.clearAll();
  useSelectionStore.getState().clear();
  loadNodes(pixel('top'), pixel('src', { label: 'Portrait' }), pixel('bottom'));
});

describe('createDepthMap (depth-map.md)', () => {
  it('adds one layer directly above the source, named "<layer> depth", with the PNG as its source', async () => {
    const { deps } = makeDeps();

    const id = await createDepthMap('src', 8, deps);

    expect(id).not.toBeNull();
    expect(ids()).toEqual(['top', id, 'src', 'bottom']);
    const layer = useSceneStore.getState().scene.nodes[1] as PixelNode;
    expect(layer.label).toBe('Portrait depth');
    expect(layer.type).toBe('pixel');
    expect(layer.sourcePath).toBe('piece.oblique.depth/file-id.png'); // relative to the project
    expect(layer.sourceSize).toEqual([40, 30]);
    expect(layer.dirty).toEqual({ draft: true, working: true }); // the scheduler cooks it
    expect(sources.get(id as string)).toBeDefined();
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: id });
  });

  it('writes the sidecar PNG bytes as they are, beside the project and not in .baked', async () => {
    const { deps } = makeDeps();
    await createDepthMap('src', 16, deps);

    expect(deps.mkdir).toHaveBeenCalledWith('/art/piece.oblique.depth', { recursive: true });
    expect(deps.writeFile).toHaveBeenCalledWith('/art/piece.oblique.depth/file-id.png', PNG);
    expect(deps.depth).toHaveBeenCalledWith(expect.objectContaining({ bits: 16 }));
    expect(deps.decode).toHaveBeenCalledWith(PNG);
  });

  it('leaves the source untouched', async () => {
    const before = useSceneStore.getState().scene.nodes.find((n) => n.id === 'src');
    const { deps } = makeDeps();
    await createDepthMap('src', 8, deps);
    expect(useSceneStore.getState().scene.nodes.find((n) => n.id === 'src')).toEqual(before);
  });

  it("gives the layer the source's 2D transform so it sits over it", async () => {
    const t = { x: 7, y: 3, scaleX: 2, scaleY: 2, rotation: 0.5 };
    loadNodes(pixel('src', { transform2d: t }));
    const { deps } = makeDeps();
    const id = (await createDepthMap('src', 8, deps)) as string;
    expect(useSceneStore.getState().scene.nodes.find((n) => n.id === id)?.transform2d).toEqual(t);
  });

  it('asks the gate first and makes no sidecar request until it says yes', async () => {
    let answer: () => void = () => {};
    const { deps, calls } = makeDeps({
      ensure: vi.fn(async (id: string) => {
        calls.push(`ensure:${id}`);
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
      }),
    });

    const pending = createDepthMap('src', 8, deps);
    await Promise.resolve();
    expect(deps.ensure).toHaveBeenCalledWith('depth_anything_v2_small', {
      for: 'Create depth map',
    });
    expect(deps.readRaster).not.toHaveBeenCalled();
    expect(deps.depth).not.toHaveBeenCalled();

    answer();
    await pending;
    expect(calls).toEqual(['ensure:depth_anything_v2_small', 'raster', 'depth', 'mkdir', 'write']);
  });

  it('Not now adds nothing, quietly: no request, no file, no message', async () => {
    const { deps } = makeDeps({
      ensure: vi.fn(async () => {
        throw new ModelDeclined('depth_anything_v2_small');
      }),
    });

    expect(await createDepthMap('src', 8, deps)).toBeNull();

    expect(ids()).toEqual(['top', 'src', 'bottom']);
    expect(deps.depth).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('in an Untitled project holds the PNG in memory under a placeholder path, and writes nothing', async () => {
    const { deps } = makeDeps({ projectPath: () => null });

    const id = (await createDepthMap('src', 8, deps)) as string;

    expect(deps.ensure).toHaveBeenCalled(); // the DownloadPrompt shows on the first try
    expect(deps.keepPending).toHaveBeenCalledWith('pending://depth/file-id.png', PNG);
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(ids()).toEqual(['top', id, 'src', 'bottom']);
    expect((useSceneStore.getState().scene.nodes[1] as PixelNode).sourcePath).toBe(
      'pending://depth/file-id.png',
    );
  });

  it('reports a model that has gone since, and adds nothing', async () => {
    const { deps } = makeDeps({
      depth: vi.fn(async () => {
        throw new ModelMissingError('depth_anything_v2_small');
      }),
    });
    expect(await createDepthMap('src', 8, deps)).toBeNull();
    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Depth Anything V2 Small isn't installed" }),
    );
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(ids()).toEqual(['top', 'src', 'bottom']);
  });

  it('reports any other failure and adds nothing', async () => {
    const { deps } = makeDeps({
      writeFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    expect(await createDepthMap('src', 8, deps)).toBeNull();
    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', description: 'disk full' }),
    );
    expect(ids()).toEqual(['top', 'src', 'bottom']);
  });

  it('adds nothing, and frees the decode, when the source was deleted meanwhile', async () => {
    const { deps, closed } = makeDeps({
      depth: vi.fn(async (options) => {
        useSceneStore.getState().removeNode('src');
        return { png: PNG, width: options.width, height: options.height, bits: 8 as const };
      }),
    });
    expect(await createDepthMap('src', 8, deps)).toBeNull();
    expect(ids()).toEqual(['top', 'bottom']);
    expect(closed).toHaveBeenCalled();
  });

  it('is for layers that cook, not for a hidden selection shape', () => {
    expect(canCreateDepthMap(pixel('a'))).toBe(true);
    expect(canCreateDepthMap(undefined)).toBe(false);
    const selection = {
      ...(pixel('s') as unknown as VectorNode),
      type: 'vector',
      role: 'selection',
      paths: [],
      fillRule: 'nonzero',
    } as VectorNode;
    expect(canCreateDepthMap(selection)).toBe(false);
  });
});
