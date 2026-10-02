import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportDeps } from '@/project/import';
import { useProjectMetaStore } from '@/project/projectMeta';
import * as backgroundSource from './backgroundSource';
import * as cache from './cache';
import * as history from './history';
import { replacePixelSource } from './replaceSource';
import * as sources from './sources';
import { useSceneStore } from './store';
import type { Modifier, PixelNode, VectorMaskRef } from './types';

vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn() }));

interface FakeBitmap {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

function bitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

/** Files on a fake disk: absolute path -> bitmap size (or 'corrupt'). */
function makeDeps(files: Record<string, [number, number] | 'corrupt'>) {
  const decoded: FakeBitmap[] = [];
  const reads: string[] = [];
  const deps: ImportDeps = {
    readFile: vi.fn(async (path: string) => {
      reads.push(path);
      if (!(path in files)) throw new Error('ENOENT');
      return new Uint8Array([Object.keys(files).indexOf(path)]);
    }),
    decode: vi.fn(async (bytes: Uint8Array) => {
      const path = Object.keys(files)[bytes[0]];
      const spec = path ? files[path] : undefined;
      if (!spec || spec === 'corrupt') throw new Error('bad image');
      const b = bitmap(spec[0], spec[1]);
      decoded.push(b);
      return b as unknown as { width: number; height: number } & sources.Closable;
    }),
  };
  return { deps, decoded, reads };
}

function pixelNode(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
  return {
    id,
    label: 'My layer',
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'multiply',
    opacity: 0.5,
    dirty: { draft: false, working: false },
    sourcePath: '/old/a.png',
    sourceSize: [512, 512],
    transform2d: { x: 100, y: 40, scaleX: -1, scaleY: 1, rotation: 0.3 },
    ...overrides,
  };
}

function setScene(nodes: PixelNode[], maskRefs?: Record<string, VectorMaskRef>) {
  useSceneStore.setState({
    scene: {
      id: 's',
      nodes,
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [1000, 1000],
      ...(maskRefs ? { maskRefs } : {}),
    },
  });
}

const node = (id = 'a') =>
  useSceneStore.getState().scene.nodes.find((n) => n.id === id) as PixelNode;

beforeEach(() => {
  sources.clearAll();
  cache.clearAll();
  backgroundSource.clear();
  history.clear();
  useProjectMetaStore.setState({ path: null, dirtySinceSave: false });
  sources.useSourceMissingStore.setState({ missing: {}, reasons: {} });
  setScene([pixelNode('a')]);
  sources.set('a', bitmap(512, 512) as unknown as ImageBitmap);
  history.clear();
});

describe('replacePixelSource', () => {
  it('lands the new file: full-resolution sourceSize, footprint kept, label/blend/opacity untouched, old bitmap closed', async () => {
    const old = sources.get('a') as unknown as FakeBitmap;
    const { deps, decoded } = makeDeps({ '/new/b.png': [4000, 2000] });
    const before = node();

    const result = await replacePixelSource('a', '/new/b.png', deps);

    expect(result).toEqual({ ok: true, missing: false });
    const after = node();
    expect(after.sourcePath).toBe('/new/b.png');
    expect(after.sourceSize).toEqual([4000, 2000]);
    expect(4000 * Math.abs(after.transform2d?.scaleX ?? 0)).toBeCloseTo(512, 9);
    expect(2000 * Math.abs(after.transform2d?.scaleY ?? 0)).toBeCloseTo(256, 9);
    expect(after.transform2d?.rotation).toBe(0.3);
    expect(Math.sign(after.transform2d?.scaleX ?? 0)).toBe(-1);
    expect(after.label).toBe('My layer');
    expect(after.blendMode).toBe('multiply');
    expect(after.opacity).toBe(0.5);
    expect(after.dirty).toEqual({ draft: true, working: true });
    expect(before.dirty).toEqual({ draft: false, working: false });
    expect(sources.get('a')).toBe(decoded[0]);
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(sources.isSourceMissing('a')).toBe(false);
  });

  it('is exactly one undo step', async () => {
    const { deps } = makeDeps({ '/new/b.png': [100, 100] });
    await replacePixelSource('a', '/new/b.png', deps);
    expect(history.canUndo()).toBe(true);
    const { deps: restoreDeps } = makeDeps({ '/old/a.png': [512, 512] });
    await history.undo(restoreDeps);
    expect(history.canUndo()).toBe(false);
  });

  it('undo restores path, size, transform AND pixels; redo puts the new image back', async () => {
    const original = node();
    const { deps } = makeDeps({ '/new/b.png': [4000, 2000] });
    await replacePixelSource('a', '/new/b.png', deps);
    const replaced = node();
    const replacedBitmap = sources.get('a');

    const disk = makeDeps({ '/old/a.png': [512, 512], '/new/b.png': [4000, 2000] });
    await history.undo(disk.deps);
    expect(node().sourcePath).toBe('/old/a.png');
    expect(node().sourceSize).toEqual([512, 512]);
    expect(node().transform2d).toEqual(original.transform2d);
    const restored = sources.get('a') as unknown as FakeBitmap;
    expect(restored.width).toBe(512); // the OLD pixels, not the replacement's
    expect(restored).not.toBe(replacedBitmap);
    expect(node().dirty).toEqual({ draft: true, working: true });

    await history.redo(disk.deps);
    expect(node().sourcePath).toBe('/new/b.png');
    expect(node().sourceSize).toEqual(replaced.sourceSize);
    expect(node().transform2d).toEqual(replaced.transform2d);
    expect((sources.get('a') as unknown as FakeBitmap).width).toBe(4000);
  });

  it('refuses strata:// and any scheme://: nothing changes and there is no undo step', async () => {
    const { deps, reads } = makeDeps({});
    const before = useSceneStore.getState().scene;
    for (const typed of ['strata://asset/1', 'https://x.test/a.png']) {
      expect(await replacePixelSource('a', typed, deps)).toEqual({
        ok: false,
        reason: 'unsupported-scheme',
      });
    }
    expect(useSceneStore.getState().scene).toBe(before);
    expect(history.canUndo()).toBe(false);
    expect(reads).toEqual([]);
    expect(sources.isSourceMissing('a')).toBe(false);
  });

  it('accepts a path that does not exist: stored verbatim, flagged missing, footprint and pixels untouched', async () => {
    const { deps } = makeDeps({});
    const before = node();
    const result = await replacePixelSource('a', '/not/there.png', deps);
    expect(result).toEqual({ ok: true, missing: true });
    expect(node().sourcePath).toBe('/not/there.png');
    expect(node().sourceSize).toEqual(before.sourceSize);
    expect(node().transform2d).toEqual(before.transform2d);
    expect(sources.isSourceMissing('a')).toBe(true);
    expect(sources.missingReason('a')).toBe('not-found');
    expect(sources.get('a')).toBeUndefined();
  });

  it('a file that does not decode is accepted and flagged "unreadable"', async () => {
    const { deps } = makeDeps({ '/x/bad.png': 'corrupt' });
    expect(await replacePixelSource('a', '/x/bad.png', deps)).toEqual({ ok: true, missing: true });
    expect(sources.missingReason('a')).toBe('unreadable');
  });

  it('relinking a missing node: the box it kept is still there to fit into', async () => {
    const { deps } = makeDeps({ '/new/b.png': [1024, 256] });
    await replacePixelSource('a', '/not/there.png', deps);
    expect(await replacePixelSource('a', '/new/b.png', deps)).toEqual({ ok: true, missing: false });
    expect(sources.isSourceMissing('a')).toBe(false);
    expect(node().sourceSize).toEqual([1024, 256]);
    expect(1024 * Math.abs(node().transform2d?.scaleX ?? 0)).toBeCloseTo(512, 9);
  });

  it('retyping the same path on a missing node retries (the file may exist now)', async () => {
    const files: Record<string, [number, number]> = {};
    const { deps } = makeDeps(files);
    await replacePixelSource('a', '/later.png', deps);
    expect(sources.isSourceMissing('a')).toBe(true);
    files['/later.png'] = [64, 64];
    await replacePixelSource('a', '/later.png', deps);
    expect(sources.isSourceMissing('a')).toBe(false);
    expect(node().sourceSize).toEqual([64, 64]);
  });

  it('the same path on a healthy node is a no-op', async () => {
    const { deps, reads } = makeDeps({ '/old/a.png': [512, 512] });
    const before = useSceneStore.getState().scene;
    expect(await replacePixelSource('a', '/old/a.png', deps)).toEqual({ ok: true, missing: false });
    expect(reads).toEqual([]);
    expect(useSceneStore.getState().scene).toBe(before);
  });

  it('a relative path in an unsaved project is accepted and flagged relative-unsaved', async () => {
    const { deps, reads } = makeDeps({ '/x/plates/a.png': [10, 10] });
    expect(await replacePixelSource('a', 'plates/a.png', deps)).toEqual({
      ok: true,
      missing: true,
    });
    expect(node().sourcePath).toBe('plates/a.png'); // verbatim
    expect(sources.missingReason('a')).toBe('relative-unsaved');
    expect(reads).toEqual([]);
  });

  it('a relative path resolves against the saved project folder, and is stored as typed', async () => {
    useProjectMetaStore.setState({ path: '/x/proj.oblique' });
    const { deps, reads } = makeDeps({ '/x/plates/a.png': [10, 20] });
    expect(await replacePixelSource('a', 'plates/a.png', deps)).toEqual({
      ok: true,
      missing: false,
    });
    expect(reads).toEqual(['/x/plates/a.png']);
    expect(node().sourcePath).toBe('plates/a.png');
    expect(node().sourceSize).toEqual([10, 20]);
  });

  it('a node deleted before the decode returns: no crash, bitmap closed, nothing lands', async () => {
    let release: (b: Uint8Array) => void = () => {};
    const b = bitmap(30, 30);
    const deps: ImportDeps = {
      readFile: () => new Promise((resolve) => (release = resolve)),
      decode: async () => b as unknown as { width: number; height: number } & sources.Closable,
    };
    const pending = replacePixelSource('a', '/new/b.png', deps);
    useSceneStore.getState().removeNode('a');
    release(new Uint8Array([1]));
    expect(await pending).toEqual({ ok: false, reason: 'stale' });
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });

  it('replaced again before the first decode returns: the stale bitmap is closed, the latest wins', async () => {
    const releases: Array<(b: Uint8Array) => void> = [];
    const made: FakeBitmap[] = [];
    const deps: ImportDeps = {
      readFile: () => new Promise((resolve) => releases.push(resolve)),
      decode: async () => {
        const b = bitmap(10 * (made.length + 1), 10);
        made.push(b);
        return b as unknown as { width: number; height: number } & sources.Closable;
      },
    };
    const first = replacePixelSource('a', '/one.png', deps);
    const second = replacePixelSource('a', '/two.png', deps);
    releases[1](new Uint8Array([1])); // the second read finishes first
    expect(await second).toEqual({ ok: true, missing: false });
    releases[0](new Uint8Array([1]));
    expect(await first).toEqual({ ok: false, reason: 'stale' });
    expect(node().sourcePath).toBe('/two.png');
    expect(sources.get('a')).toBe(made[0]); // decoded first by call order, landed by the second replace
    expect(made[1].close).toHaveBeenCalledTimes(1);
    expect(made[0].close).not.toHaveBeenCalled();
  });

  it('refuses a locked node', async () => {
    setScene([pixelNode('a', { state: 'locked' })]);
    const { deps } = makeDeps({ '/new/b.png': [10, 10] });
    expect(await replacePixelSource('a', '/new/b.png', deps)).toEqual({
      ok: false,
      reason: 'locked',
    });
    expect(node().sourcePath).toBe('/old/a.png');
  });
});

describe('store.setPixelSource and node-space masks', () => {
  const blur: Modifier = {
    id: 'm1',
    type: 'gaussian_blur',
    enabled: true,
    params: { radius: 2 },
    maskId: 'mask1',
  };

  it('without a size changes only the path (and dirties): the footprint is kept', () => {
    useSceneStore.getState().setPixelSource('a', '/elsewhere.png');
    expect(node().sourcePath).toBe('/elsewhere.png');
    expect(node().sourceSize).toEqual([512, 512]);
    expect(node().transform2d).toEqual({ x: 100, y: 40, scaleX: -1, scaleY: 1, rotation: 0.3 });
    expect(node().dirty).toEqual({ draft: true, working: true });
  });

  it('refits a node-space mask attachTransform so the mask stays put; leaves document-space refs alone', () => {
    const attach = { x: 100, y: 40, scaleX: -1, scaleY: 1, rotation: 0.3 };
    setScene([pixelNode('a', { modifiers: [blur, { ...blur, id: 'm2', maskId: 'mask2' }] })], {
      mask1: {
        id: 'mask1',
        nodeId: 'v',
        featherPx: 0,
        expand: 0,
        invert: false,
        space: 'node',
        attachTransform: attach,
      },
      mask2: { id: 'mask2', nodeId: 'v', featherPx: 0, expand: 0, invert: false },
    });
    useSceneStore.getState().setPixelSource('a', '/new/b.png', [1024, 256]);
    const refs = useSceneStore.getState().scene.maskRefs;
    const next = node().transform2d;
    expect(refs?.mask1.attachTransform).not.toEqual(attach);
    // Same node frame at attach time as now: the refit snapshot IS the new transform.
    expect(refs?.mask1.attachTransform?.x).toBeCloseTo(next?.x ?? Number.NaN, 9);
    expect(refs?.mask1.attachTransform?.scaleX).toBeCloseTo(next?.scaleX ?? Number.NaN, 9);
    expect(refs?.mask2).toEqual({
      id: 'mask2',
      nodeId: 'v',
      featherPx: 0,
      expand: 0,
      invert: false,
    });
  });
});
