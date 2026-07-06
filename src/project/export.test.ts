import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Composite2DContext } from '@/compositor/composite';
import type { PixelNode, Scene, SceneNode } from '@/scene/types';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  rename: vi.fn(),
}));

import { toast } from 'sonner';
import type { ExportCanvas, ExportDeps } from './export';
import { exportableNodes, exportPng, suggestedExportName } from './export';

function fakeBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

function pixelNode(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
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

/** Records every drawImage call so tests can assert the composite actually ran. */
function fakeCtx(): Composite2DContext & {
  drawCalls: number;
  translateCalls: [number, number][];
} {
  const translateCalls: [number, number][] = [];
  const ctx = {
    drawCalls: 0,
    translateCalls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    imageSmoothingEnabled: false,
    drawImage: vi.fn(() => {
      ctx.drawCalls++;
    }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn((x: number, y: number) => {
      translateCalls.push([x, y]);
    }),
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
  return ctx as unknown as Composite2DContext & {
    drawCalls: number;
    translateCalls: [number, number][];
  };
}

function makeDeps(
  scene: Scene,
  overrides: Partial<ExportDeps> = {},
): ExportDeps & { ctx: ReturnType<typeof fakeCtx> } {
  const ctx = fakeCtx();
  const canvas: ExportCanvas = {
    getContext: () => ctx,
    convertToBlob: vi.fn(async () => new Blob(['fake-png'])),
  };
  return {
    getScene: () => scene,
    cookFullRes: vi.fn(async () => fakeBitmap()),
    getBaked: vi.fn(() => undefined),
    createCanvas: vi.fn(() => canvas),
    blobToBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    pickSavePath: vi.fn(async () => '/out/export.png'),
    writeFile: vi.fn(async () => {}),
    ctx,
    ...overrides,
  };
}

describe('exportableNodes', () => {
  it('keeps visible nodes of both output types — masks must cook so the span walk can clip', () => {
    const nodes = [
      pixelNode('a', { visible: true, output: 'image' }),
      pixelNode('b', { visible: false, output: 'image' }),
      pixelNode('c', { visible: true, output: 'mask' }),
    ];
    expect(exportableNodes(makeScene(nodes)).map((n) => n.id)).toEqual(['a', 'c']);
  });
});

describe('suggestedExportName', () => {
  it('derives from the project path, stripping the .oblique extension', () => {
    expect(suggestedExportName('/Users/g/art/piece.oblique')).toBe('piece.png');
  });

  it('falls back to untitled.png with no project path', () => {
    expect(suggestedExportName(null)).toBe('untitled.png');
  });
});

describe('exportPng', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cooks every visible image node at full res, composites, and writes the PNG', async () => {
    const nodes = [pixelNode('a'), pixelNode('b', { visible: false })];
    const scene = makeScene(nodes);
    const deps = makeDeps(scene);

    await exportPng(deps);

    expect(deps.cookFullRes).toHaveBeenCalledTimes(1); // only the visible node
    expect(deps.cookFullRes).toHaveBeenCalledWith('a');
    expect(deps.createCanvas).toHaveBeenCalledWith(200, 100); // documentSize, not upscaled/downscaled
    expect(deps.ctx.drawCalls).toBeGreaterThan(0); // compositeScene actually drew something
    expect(deps.writeFile).toHaveBeenCalledWith('/out/export.png', expect.any(Uint8Array));
    expect(toast.success).toHaveBeenCalled();
  });

  it('cooks mask-output nodes too, so masked spans survive into the PNG (mask-span-scoping.md)', async () => {
    const nodes = [
      pixelNode('clip', { output: 'mask' }), // index 0 = stack top — clips 'content' below it
      pixelNode('content'),
    ];
    const deps = makeDeps(makeScene(nodes));

    await exportPng(deps);

    // Both cook: the mask's raster is the clip bitmap, without it the span vanishes.
    expect(deps.cookFullRes).toHaveBeenCalledTimes(2);
    expect(deps.cookFullRes).toHaveBeenCalledWith('clip');
    // Main canvas + one scratch for the single masked span.
    expect(deps.createCanvas).toHaveBeenCalledTimes(2);
    expect(deps.ctx.drawCalls).toBeGreaterThan(0);
    expect(deps.writeFile).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it("applies a node's transform2d in the export composite (baked level — translation unscaled)", async () => {
    const nodes = [
      pixelNode('a', {
        transform2d: { x: 30, y: 10, scaleX: 1, scaleY: 1, rotation: 0 },
      }),
    ];
    const deps = makeDeps(makeScene(nodes));

    await exportPng(deps);

    expect(deps.ctx.translateCalls[0]).toEqual([30, 10]);
  });

  it("aborts (no save, no draft substitution) when a node's full-res cook fails", async () => {
    const nodes = [pixelNode('a')];
    const scene = makeScene(nodes);
    const deps = makeDeps(scene, {
      cookFullRes: vi.fn(async () => {
        throw new Error('sidecar down');
      }),
    });

    await exportPng(deps);

    expect(deps.createCanvas).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Export failed',
      expect.objectContaining({ description: expect.stringContaining('sidecar down') }),
    );
  });

  it('does nothing (no toast.success) when the document has no size', async () => {
    const deps = makeDeps(makeScene([], [0, 0]));

    await exportPng(deps);

    expect(deps.cookFullRes).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Nothing to export', expect.anything());
  });

  it('cooks nothing and writes nothing when the save dialog is cancelled (dialog comes first)', async () => {
    const nodes = [pixelNode('a')];
    const deps = makeDeps(makeScene(nodes), { pickSavePath: vi.fn(async () => null) });

    await exportPng(deps);

    expect(deps.cookFullRes).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('uses the baked cache for a locked node instead of recooking it (lock-state-machine.md)', async () => {
    const baked = fakeBitmap();
    const nodes = [pixelNode('locked', { state: 'locked' }), pixelNode('active')];
    const deps = makeDeps(makeScene(nodes), {
      getBaked: vi.fn((id: string) => (id === 'locked' ? baked : undefined)),
    });

    await exportPng(deps);

    expect(deps.getBaked).toHaveBeenCalledWith('locked');
    expect(deps.cookFullRes).toHaveBeenCalledTimes(1);
    expect(deps.cookFullRes).toHaveBeenCalledWith('active');
    expect(deps.cookFullRes).not.toHaveBeenCalledWith('locked');
    // The shared baked bitmap must survive the export — it's the live cache
    // entry, not a one-shot cook.
    expect(baked.close).not.toHaveBeenCalled();
  });

  it('falls back to cookFullRes for a locked node whose baked cache is empty (not yet rehydrated)', async () => {
    const nodes = [pixelNode('locked', { state: 'locked' })];
    const deps = makeDeps(makeScene(nodes), {
      getBaked: vi.fn(() => undefined),
    });

    await exportPng(deps);

    expect(deps.cookFullRes).toHaveBeenCalledWith('locked');
  });

  it('closes every cooked bitmap after use, even on failure', async () => {
    const bitmap = fakeBitmap();
    const nodes = [pixelNode('a')];
    const deps = makeDeps(makeScene(nodes), {
      cookFullRes: vi.fn(async () => bitmap),
      writeFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    await exportPng(deps);

    expect(bitmap.close).toHaveBeenCalled();
  });
});
