import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Composite2DContext } from '@/compositor/composite';
import type { PixelNode, Scene, SceneNode } from '@/scene/types';

vi.mock('@preset.nz/ux-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@preset.nz/ux-kit')>()),
  notify: vi.fn(() => 'toast-id'),
  dismissNotification: vi.fn(),
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

import { dismissNotification, notify } from '@preset.nz/ux-kit';
import * as backgroundSource from '@/scene/backgroundSource';
import type { ExportCanvas, ExportDeps } from './export';
import { exportableNodes, exportPng, exportProof, suggestedExportName } from './export';

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
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
  });

  it('shows a persistent progress snackbar with Cancel, and dismisses it before the result', async () => {
    const deps = makeDeps(makeScene([pixelNode('a')]));

    await exportPng(deps);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/^Exporting 1 \/ 1/),
        persistent: true,
        action: expect.objectContaining({ label: 'Cancel' }),
      }),
    );
    expect(dismissNotification).toHaveBeenCalledWith('toast-id');
  });

  it('includes the document background image at native size, before the nodes (background-image.md)', async () => {
    const bg = fakeBitmap();
    backgroundSource.set('/bg.png', bg);
    const scene = makeScene([pixelNode('a')]);
    scene.background = { type: 'image', sourcePath: '/bg.png', sourceSize: [60, 40] };
    const deps = makeDeps(scene);

    await exportPng(deps);

    const calls = (deps.ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual([bg, 0, 0, 60, 40]); // baked level: unscaled native size
    expect(calls).toHaveLength(2);
    backgroundSource.clear();
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
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
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
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Export failed',
        kind: 'error',
        description: expect.stringContaining('sidecar down'),
      }),
    );
  });

  it('does nothing (no success snackbar) when the document has no size', async () => {
    const deps = makeDeps(makeScene([], [0, 0]));

    await exportPng(deps);

    expect(deps.cookFullRes).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Nothing to export', kind: 'error' }),
    );
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

describe('exportProof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const proofOptions = {
    margin: 10 as number | null,
    paper: 'white' as const,
    marks: true,
    edgeMarks: false,
    bars: true,
    steps: 5 as const,
    barEdge: 'bottom' as const,
  };

  it('renders the same composite, then wraps it in a margin canvas and writes it', async () => {
    const work = fakeCtx();
    const sheet = Object.assign(fakeCtx(), { arc: vi.fn() });
    const workCanvas: ExportCanvas = {
      getContext: () => work,
      convertToBlob: vi.fn(async () => new Blob(['work'])),
    };
    const sheetCanvas: ExportCanvas = {
      getContext: () => sheet,
      convertToBlob: vi.fn(async () => new Blob(['sheet'])),
    };
    const createCanvas = vi.fn((w: number, h: number) =>
      w === 200 && h === 100 ? workCanvas : sheetCanvas,
    );
    const deps = makeDeps(makeScene([pixelNode('a')]), { createCanvas });

    await exportProof(proofOptions, deps);

    expect(createCanvas).toHaveBeenCalledWith(200, 100); // plain-export size
    expect(createCanvas).toHaveBeenCalledWith(220, 120); // + 2 × margin
    const proofDraws = (sheet.drawImage as ReturnType<typeof vi.fn>).mock.calls;
    expect(proofDraws).toEqual([[workCanvas, 10, 10]]); // once, native size, no size args
    expect(sheetCanvas.convertToBlob).toHaveBeenCalled();
    expect(workCanvas.convertToBlob).not.toHaveBeenCalled();
    expect(deps.writeFile).toHaveBeenCalledWith('/out/export.png', expect.any(Uint8Array));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
  });

  it('defaults a null margin to 8% of the short edge', async () => {
    const deps = makeDeps(makeScene([pixelNode('a')], [200, 100]));
    await exportProof({ ...proofOptions, margin: null }, deps);
    expect(deps.createCanvas).toHaveBeenCalledWith(216, 116); // round(100 × 0.08) = 8
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    const deps = makeDeps(makeScene([pixelNode('a')]), { pickSavePath: vi.fn(async () => null) });
    await exportProof(proofOptions, deps);
    expect(deps.cookFullRes).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });
});
