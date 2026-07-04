import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { PixelNode } from '@/scene/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
}));

import { toast } from 'sonner';
import type { ImportDeps } from './import';
import { importFile, importFiles } from './import';

/** Minimal ImageBitmap-like stub — vitest's node environment has no real ImageBitmap. */
function fakeBitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

/** Deps whose decode result depends on which path was read (paired via readFile's echo). */
function makeDepsForPaths(sizeByPath: Record<string, [number, number]>): ImportDeps {
  const pathByBytesLength = new Map<number, string>();
  return {
    readFile: vi.fn(async (path: string) => {
      const marker = new Uint8Array([path.length]);
      pathByBytesLength.set(path.length, path);
      return marker;
    }),
    decode: vi.fn(async (bytes: Uint8Array) => {
      const path = pathByBytesLength.get(bytes[0]);
      if (!path) throw new Error('unknown path for decode');
      const [width, height] = sizeByPath[path] ?? [10, 10];
      return fakeBitmap(width, height);
    }),
  };
}

beforeEach(() => {
  useSceneStore.setState({
    scene: {
      id: 'scene-1',
      nodes: [],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [0, 0],
    },
  });
  sources.clearAll();
  vi.clearAllMocks();
});

describe('importFile', () => {
  it('adds a pixel node with the story-mandated defaults', async () => {
    const deps = makeDepsForPaths({ '/a.png': [200, 100] });
    await importFile('/a.png', deps);

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node.output).toBe('image');
    expect(node.state).toBe('active');
    expect(node.visible).toBe(true);
    expect(node.blendMode).toBe('normal');
    expect(node.opacity).toBe(1);
    expect(node.modifiers).toEqual([]);
    expect(node.dirty).toEqual({ draft: true, working: true });
    expect(node.label).toBe('a.png');
    expect((node as PixelNode).sourcePath).toBe('/a.png');
    expect((node as PixelNode).sourceSize).toEqual([200, 100]);
  });

  it('stores the decoded bitmap in the sources map, keyed by the new node id', async () => {
    const deps = makeDepsForPaths({ '/a.png': [50, 60] });
    const { nodeId } = await importFile('/a.png', deps);
    expect(nodeId).toBeDefined();
    expect(sources.get(nodeId as string)).toBeDefined();
    expect((sources.get(nodeId as string) as unknown as { width: number }).width).toBe(50);
  });

  it('sets documentSize from the first imported node only', async () => {
    const deps = makeDepsForPaths({ '/a.png': [300, 200], '/b.png': [10, 10] });
    await importFile('/a.png', deps);
    expect(useSceneStore.getState().scene.documentSize).toEqual([300, 200]);

    await importFile('/b.png', deps);
    // Second node keeps its own size but does not move documentSize.
    expect(useSceneStore.getState().scene.documentSize).toEqual([300, 200]);
    expect(useSceneStore.getState().scene.nodes).toHaveLength(2);
  });

  it('decode failure: no node created, toast.error called with filename', async () => {
    const deps: ImportDeps = {
      readFile: vi.fn(async () => new Uint8Array([1])),
      decode: vi.fn(async () => {
        throw new Error('corrupt image data');
      }),
    };

    const outcome = await importFile('/broken.jpg', deps);

    expect(outcome.error).toBe('corrupt image data');
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('broken.jpg');
  });

  it('read failure also surfaces as a toast with no node created', async () => {
    const deps: ImportDeps = {
      readFile: vi.fn(async () => {
        throw new Error('file not found');
      }),
      decode: vi.fn(),
    };

    const outcome = await importFile('/missing.png', deps);
    expect(outcome.error).toBe('file not found');
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe('import document-size gating (roadmap "Import must not always adopt the image\'s size", 2026-07-05)', () => {
  it('empty/unset doc (no nodes, documentSize [0,0]): first import adopts the image size', async () => {
    const deps = makeDepsForPaths({ '/a.png': [300, 200] });
    await importFile('/a.png', deps);
    expect(useSceneStore.getState().scene.documentSize).toEqual([300, 200]);
  });

  it('document size already set via document-setup (no nodes yet): import does not adopt the image size', async () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, documentSize: [1024, 768] },
    }));
    const deps = makeDepsForPaths({ '/a.png': [300, 200] });
    await importFile('/a.png', deps);

    expect(useSceneStore.getState().scene.documentSize).toEqual([1024, 768]);
    const node = useSceneStore.getState().scene.nodes[0] as PixelNode;
    expect(node.sourceSize).toEqual([300, 200]);
  });

  it('non-empty composition: import keeps the canvas as-is regardless of documentSize', async () => {
    const deps = makeDepsForPaths({ '/a.png': [300, 200], '/b.png': [50, 50] });
    await importFile('/a.png', deps);
    expect(useSceneStore.getState().scene.documentSize).toEqual([300, 200]);

    await importFile('/b.png', deps);
    expect(useSceneStore.getState().scene.documentSize).toEqual([300, 200]);
    const nodes = useSceneStore.getState().scene.nodes as PixelNode[];
    expect(nodes.find((n) => n.sourcePath === '/b.png')?.sourceSize).toEqual([50, 50]);
  });
});

describe('importFiles', () => {
  it('imports serially and preserves a deterministic stack order (last dropped ends on top)', async () => {
    const paths = ['/1.png', '/2.png', '/3.png', '/4.png', '/5.png'];
    const sizeByPath = Object.fromEntries(
      paths.map((p, i) => [p, [10 + i, 10 + i] as [number, number]]),
    );
    const deps = makeDepsForPaths(sizeByPath);

    const outcomes = await importFiles(paths, deps);

    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.nodeId && !o.error)).toBe(true);

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes).toHaveLength(5);
    // addPixelNode inserts at index 0, so serial import in drop order means
    // the last-processed path ends up on top; order is fully deterministic.
    expect(nodes.map((n) => (n as PixelNode).sourcePath)).toEqual([...paths].reverse());
  });

  it('one corrupt file among several does not block the rest', async () => {
    const deps: ImportDeps = {
      readFile: vi.fn(async (path: string) => new TextEncoder().encode(path)),
      decode: vi.fn(async (bytes: Uint8Array) => {
        const path = new TextDecoder().decode(bytes);
        if (path === '/broken.png') throw new Error('bad file');
        return fakeBitmap(10, 10);
      }),
    };

    const outcomes = await importFiles(['/a.png', '/broken.png', '/c.png'], deps);
    expect(outcomes.map((o) => Boolean(o.error))).toEqual([false, true, false]);
    expect(useSceneStore.getState().scene.nodes).toHaveLength(2);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
