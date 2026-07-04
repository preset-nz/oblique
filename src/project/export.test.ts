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
function fakeCtx(): Composite2DContext & { drawCalls: number } {
  const ctx = {
    drawCalls: 0,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    imageSmoothingEnabled: false,
    drawImage: vi.fn(() => {
      ctx.drawCalls++;
    }),
    save: vi.fn(),
    restore: vi.fn(),
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
  return ctx as unknown as Composite2DContext & { drawCalls: number };
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
    createCanvas: vi.fn(() => canvas),
    blobToBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    pickSavePath: vi.fn(async () => '/out/export.png'),
    writeFile: vi.fn(async () => {}),
    ctx,
    ...overrides,
  };
}

describe('exportableNodes', () => {
  it('keeps only visible, image-output nodes', () => {
    const nodes = [
      pixelNode('a', { visible: true, output: 'image' }),
      pixelNode('b', { visible: false, output: 'image' }),
      pixelNode('c', { visible: true, output: 'mask' }),
    ];
    expect(exportableNodes(makeScene(nodes)).map((n) => n.id)).toEqual(['a']);
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

  it('does not write the file when the save dialog is cancelled', async () => {
    const nodes = [pixelNode('a')];
    const deps = makeDeps(makeScene(nodes), { pickSavePath: vi.fn(async () => null) });

    await exportPng(deps);

    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('closes every cooked bitmap after use, even on failure', async () => {
    const bitmap = fakeBitmap();
    const nodes = [pixelNode('a')];
    const deps = makeDeps(makeScene(nodes), {
      cookFullRes: vi.fn(async () => bitmap),
      pickSavePath: vi.fn(async () => null),
    });

    await exportPng(deps);

    expect(bitmap.close).toHaveBeenCalled();
  });
});
