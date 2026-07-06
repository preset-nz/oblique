import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  remove: vi.fn(),
  writeFile: vi.fn(),
}));

import { toast } from 'sonner';
import * as cache from '@/scene/cache';
import * as history from '@/scene/history';
import * as importModule from './import';
import type { ProjectIoDeps } from './io';
import {
  importImagesDialog,
  loadProject,
  newProject,
  openProjectDialog,
  parseProject,
  serialiseProject,
  useProjectMetaStore,
  writeProjectFile,
} from './io';

function sampleScene(): Scene {
  return {
    id: 'scene-1',
    nodes: [
      {
        id: 'n1',
        label: 'a.png',
        type: 'pixel',
        state: 'active',
        output: 'image',
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 3 } }],
        visible: true,
        blendMode: 'normal',
        opacity: 1,
        dirty: { draft: false, working: false },
        // Round-trip acceptance for node-transform-2d.md: plain scene data,
        // must survive save/load verbatim.
        transform2d: { x: 12, y: -4, scaleX: 2, scaleY: 0.5, rotation: Math.PI / 6 },
        sourcePath: '/pics/a.png',
        sourceSize: [200, 100],
        // biome-ignore lint/suspicious/noExplicitAny: PixelNode via SceneNode[] slot
      } as any,
    ],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [200, 100],
  };
}

function makeDeps(overrides: Partial<ProjectIoDeps> = {}): ProjectIoDeps {
  return {
    readTextFile: vi.fn(async () => serialiseProject(sampleScene())),
    writeTextFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array([1])),
    decode: vi.fn(async () => ({ width: 200, height: 100, close: vi.fn() })),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readDir: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
    encodePng: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    ...overrides,
  };
}

/** A fake bitmap good enough for `cache.set`/`writeBakedSidecar` — never a real ImageBitmap in tests. */
function fakeBitmap(): ImageBitmap {
  return { width: 200, height: 100, close: vi.fn() } as unknown as ImageBitmap;
}

beforeEach(() => {
  useSceneStore.setState({
    scene: {
      id: 'empty',
      nodes: [],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [0, 0],
    },
  });
  useProjectMetaStore.setState({ path: null, dirtySinceSave: false });
  sources.clearAll();
  cache.clearAll();
  vi.clearAllMocks();
});

describe('serialise/parse round trip', () => {
  it('load(save(scene)) deep-equals scene', () => {
    const scene = sampleScene();
    expect(parseProject(serialiseProject(scene))).toEqual(scene);
  });

  it('scene with modifier masks round-trips verbatim (selection-to-mask.md)', () => {
    const scene = sampleScene();
    scene.nodes[0].modifiers[0].maskId = 'mask-1';
    scene.masks = {
      'mask-1': {
        id: 'mask-1',
        shape: {
          kind: 'lasso',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 5, y: 8 },
          ],
        },
        appliedTransform2d: { x: 12, y: -4, scaleX: 2, scaleY: 0.5, rotation: Math.PI / 6 },
        featherPx: 4,
        expand: -2,
        invert: true,
      },
    };
    expect(parseProject(serialiseProject(scene))).toEqual(scene);
  });

  it('maskless scene serialises with no masks key — pre-mask files stay verbatim', () => {
    expect(serialiseProject(sampleScene())).not.toContain('"masks"');
  });

  it('scene with a vector node round-trips verbatim (vector-node-model.md)', () => {
    const scene = sampleScene();
    scene.nodes.push({
      id: 'n2',
      label: 'Triangle',
      type: 'vector',
      state: 'active',
      output: 'image',
      modifiers: [],
      visible: true,
      blendMode: 'normal',
      opacity: 1,
      dirty: { draft: false, working: false },
      paths: [
        {
          closed: true,
          anchors: [
            { point: { x: 0, y: 0 }, handleOut: { x: 5, y: -5 } },
            { point: { x: 20, y: 0 }, handleIn: { x: 15, y: -5 } },
            { point: { x: 10, y: 20 } },
          ],
        },
      ],
      fillRule: 'evenodd',
      // biome-ignore lint/suspicious/noExplicitAny: VectorNode via SceneNode[] slot
    } as any);
    expect(parseProject(serialiseProject(scene))).toEqual(scene);
  });

  it('scene with a live vector-referenced modifier mask round-trips verbatim (vector-modifier-masks.md)', () => {
    const scene = sampleScene();
    scene.nodes.push({
      id: 'v1',
      label: 'Vector',
      type: 'vector',
      state: 'active',
      output: 'image',
      modifiers: [],
      visible: true,
      blendMode: 'normal',
      opacity: 1,
      dirty: { draft: false, working: false },
      paths: [],
      fillRule: 'nonzero',
      // biome-ignore lint/suspicious/noExplicitAny: VectorNode via SceneNode[] slot
    } as any);
    scene.nodes[0].modifiers[0].maskId = 'ref-1';
    scene.maskRefs = {
      'ref-1': {
        id: 'ref-1',
        nodeId: 'v1',
        featherPx: 6,
        expand: 1,
        invert: true,
      },
    };
    expect(parseProject(serialiseProject(scene))).toEqual(scene);
  });

  it('a pre-Epic-06 (.oblique from Epic 05, baked masks only) scene has no maskRefs key — loads verbatim', () => {
    const scene = sampleScene();
    scene.nodes[0].modifiers[0].maskId = 'mask-1';
    scene.masks = {
      'mask-1': {
        id: 'mask-1',
        shape: { kind: 'rect', rect: { x: 0, y: 0, w: 10, h: 10 } },
        appliedTransform2d: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        featherPx: 0,
        expand: 0,
        invert: false,
      },
    };
    const text = serialiseProject(scene);
    expect(text).not.toContain('"maskRefs"');
    expect(parseProject(text)).toEqual(scene);
  });

  it('rejects non-JSON', () => {
    expect(() => parseProject('nope{')).toThrow(/not valid JSON/);
  });

  it('rejects wrong format marker', () => {
    expect(() => parseProject(JSON.stringify({ format: 'other', version: 1, scene: {} }))).toThrow(
      /not an Oblique project/,
    );
  });

  it('rejects unknown version without half-loading', () => {
    const text = JSON.stringify({ format: 'oblique-project', version: 99, scene: {} });
    expect(() => parseProject(text)).toThrow(/version 99/);
  });

  it('names the accepted version range in the error message', () => {
    const text = JSON.stringify({ format: 'oblique-project', version: 3, scene: {} });
    expect(() => parseProject(text)).toThrow(/1-2/);
  });

  it('accepts a v1 file (baked-persistence.md: pre-v2 files load verbatim)', () => {
    const scene = sampleScene();
    const text = JSON.stringify({ format: 'oblique-project', version: 1, scene });
    expect(parseProject(text)).toEqual(scene);
  });

  it('accepts a v2 file', () => {
    const scene = sampleScene();
    const text = JSON.stringify({ format: 'oblique-project', version: 2, scene });
    expect(parseProject(text)).toEqual(scene);
  });

  it('saves always write version 2', () => {
    const doc = JSON.parse(serialiseProject(sampleScene()));
    expect(doc.version).toBe(2);
  });
});

describe('writeProjectFile', () => {
  it('writes a temp file then renames over the target (atomic)', async () => {
    const deps = makeDeps();
    await writeProjectFile('/proj/x.oblique', sampleScene(), deps);

    const writtenPath = (deps.writeTextFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writtenPath).toMatch(/^\/proj\/x\.oblique\.tmp-/);
    expect(deps.rename).toHaveBeenCalledWith(writtenPath, '/proj/x.oblique');
  });

  it('no locked nodes: never touches the baked sidecar dir', async () => {
    const deps = makeDeps();
    await writeProjectFile('/proj/x.oblique', sampleScene(), deps);

    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('locked node with a baked bitmap: writes exactly one PNG named after the node id', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    cache.set('n1', 'baked', fakeBitmap());
    const deps = makeDeps();

    await writeProjectFile('/proj/x.oblique', scene, deps);

    expect(deps.mkdir).toHaveBeenCalledWith('/proj/x.oblique.baked', { recursive: true });
    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/proj/x.oblique.baked/n1.png',
      expect.any(Uint8Array),
    );
  });

  it('two locked nodes: baked dir gets exactly two PNGs (acceptance: "exactly two")', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    scene.nodes.push({ ...scene.nodes[0], id: 'n2', state: 'locked' });
    cache.set('n1', 'baked', fakeBitmap());
    cache.set('n2', 'baked', fakeBitmap());
    const deps = makeDeps();

    await writeProjectFile('/proj/x.oblique', scene, deps);

    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    const writtenPaths = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(writtenPaths.sort()).toEqual([
      '/proj/x.oblique.baked/n1.png',
      '/proj/x.oblique.baked/n2.png',
    ]);
  });

  it('locked node whose baked cache is empty (mid-rehydrate): skipped, not an error', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked'; // cache never populated for n1
    const deps = makeDeps();

    await expect(writeProjectFile('/proj/x.oblique', scene, deps)).resolves.not.toThrow();
    expect(deps.writeFile).not.toHaveBeenCalled();
    // Nothing survives (freshly mkdir'd, nothing written, nothing pre-existing) — cleaned up.
    expect(deps.remove).toHaveBeenCalledWith('/proj/x.oblique.baked', { recursive: true });
  });

  it('unlock then save: the stale PNG is swept from the dir', async () => {
    const scene = sampleScene(); // n1 active
    const deps = makeDeps({ readDir: vi.fn(async () => [{ name: 'n1.png' }]) });

    scene.nodes.push({ ...scene.nodes[0], id: 'n2', state: 'locked' });
    cache.set('n2', 'baked', fakeBitmap());

    await writeProjectFile('/proj/x.oblique', scene, deps);

    expect(deps.remove).toHaveBeenCalledWith('/proj/x.oblique.baked/n1.png', undefined);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/proj/x.oblique.baked/n2.png',
      expect.any(Uint8Array),
    );
  });

  it('unlock the only locked node then save: the whole dir is removed', async () => {
    const scene = sampleScene(); // no locked nodes
    const deps = makeDeps();

    await writeProjectFile('/proj/x.oblique', scene, deps);

    expect(deps.remove).toHaveBeenCalledWith('/proj/x.oblique.baked', { recursive: true });
    expect(deps.mkdir).not.toHaveBeenCalled();
  });

  it('save-as: writes a fresh dir beside the new path, leaves the old one untouched', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    cache.set('n1', 'baked', fakeBitmap());
    const deps = makeDeps();

    await writeProjectFile('/proj/new.oblique', scene, deps);

    expect(deps.mkdir).toHaveBeenCalledWith('/proj/new.oblique.baked', { recursive: true });
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/proj/new.oblique.baked/n1.png',
      expect.any(Uint8Array),
    );
    expect(deps.remove).not.toHaveBeenCalledWith(
      expect.stringContaining('/proj/x.oblique.baked'),
      expect.anything(),
    );
  });
});

describe('loadProject', () => {
  it('loads the scene verbatim, rehydrates sources, marks nodes draft-dirty', async () => {
    const deps = makeDeps();
    await loadProject('/proj/x.oblique', deps);

    const { scene } = useSceneStore.getState();
    expect(scene.id).toBe('scene-1');
    expect(scene.nodes[0].dirty).toEqual({ draft: true, working: true });
    expect(sources.get('n1')).toBeDefined();
    expect(sources.isSourceMissing('n1')).toBe(false);
    expect(useProjectMetaStore.getState().path).toBe('/proj/x.oblique');
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);
  });

  it('missing source file: node kept, flagged sourceMissing, path preserved', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => {
        throw new Error('gone');
      }),
    });
    await loadProject('/proj/x.oblique', deps);

    const node = useSceneStore.getState().scene.nodes[0];
    expect(node).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: pixel field access in test
    expect((node as any).sourcePath).toBe('/pics/a.png');
    expect(sources.isSourceMissing('n1')).toBe(true);
  });

  it('corrupt file: toast with filename, scene untouched, app healthy', async () => {
    const deps = makeDeps({ readTextFile: vi.fn(async () => '{broken') });
    await loadProject('/proj/bad.oblique', deps);

    expect(useSceneStore.getState().scene.id).toBe('empty');
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('bad.oblique');
  });

  describe('baked-bitmap rehydration (baked-persistence.md)', () => {
    function lockedScene() {
      const scene = sampleScene();
      scene.nodes[0].state = 'locked';
      return scene;
    }

    it('a locked node with a decodable sidecar PNG: cache populated, no cook needed', async () => {
      const readFile = vi.fn(async (path: string) => {
        if (path === '/proj/x.oblique.baked/n1.png') return new Uint8Array([9, 9]);
        return new Uint8Array([1]);
      });
      const decode = vi.fn(async () => ({ width: 200, height: 100, close: vi.fn() }));
      const deps = makeDeps({
        readTextFile: vi.fn(async () => serialiseProject(lockedScene())),
        readFile,
        decode,
      });

      await loadProject('/proj/x.oblique', deps);

      expect(readFile).toHaveBeenCalledWith('/proj/x.oblique.baked/n1.png');
      expect(cache.get('n1', 'baked')).toBeDefined();
    });

    it('missing sidecar PNG: non-fatal, cache slot left empty for the scheduler to recover', async () => {
      const deps = makeDeps({
        readTextFile: vi.fn(async () => serialiseProject(lockedScene())),
        readFile: vi.fn(async (path: string) => {
          if (path === '/proj/x.oblique.baked/n1.png') throw new Error('ENOENT');
          return new Uint8Array([1]);
        }),
      });

      await expect(loadProject('/proj/x.oblique', deps)).resolves.not.toThrow();
      expect(cache.get('n1', 'baked')).toBeUndefined();
      expect(toast.error).not.toHaveBeenCalled();
      expect(useSceneStore.getState().scene.id).toBe('scene-1');
    });

    it('corrupt sidecar PNG: non-fatal, cache slot left empty', async () => {
      const deps = makeDeps({
        readTextFile: vi.fn(async () => serialiseProject(lockedScene())),
        decode: vi.fn(async () => {
          throw new Error('bad PNG');
        }),
      });

      await expect(loadProject('/proj/x.oblique', deps)).resolves.not.toThrow();
      expect(cache.get('n1', 'baked')).toBeUndefined();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('a v1 project (no baked sidecar ever written) still opens; locked nodes just rehydrate', async () => {
      const scene = lockedScene();
      const text = JSON.stringify({ format: 'oblique-project', version: 1, scene });
      const deps = makeDeps({
        readTextFile: vi.fn(async () => text),
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('.baked/n1.png')) throw new Error('ENOENT');
          return new Uint8Array([1]);
        }),
      });

      await expect(loadProject('/proj/x.oblique', deps)).resolves.not.toThrow();
      expect(useSceneStore.getState().scene.id).toBe('scene-1');
      expect(cache.get('n1', 'baked')).toBeUndefined();
    });

    it('save then load round-trip: the bytes this save wrote are exactly what the next load decodes', async () => {
      // A fake filesystem — just enough to make save's writeFile output
      // reachable by load's readFile, the way a real disk would.
      const fs = new Map<string, Uint8Array>();
      const scene = lockedScene();
      cache.set('n1', 'baked', fakeBitmap());
      const pngBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

      const saveDeps = makeDeps({
        writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
          fs.set(path, bytes);
        }),
        encodePng: vi.fn(async () => pngBytes),
      });
      await writeProjectFile('/proj/round.oblique', scene, saveDeps);
      expect(fs.get('/proj/round.oblique.baked/n1.png')).toEqual(pngBytes);

      // Reset the cache the way a real reopen would find it (nothing in
      // memory) — the round-trip has to come entirely from `fs`.
      cache.clearAll();

      const decode = vi.fn(async (bytes: Uint8Array) => ({
        width: 200,
        height: 100,
        close: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: tagging the decoded bytes for the assertion below
        _bytes: bytes as any,
      }));
      const loadDeps = makeDeps({
        readTextFile: vi.fn(async () => serialiseProject(scene)),
        readFile: vi.fn(async (path: string) => {
          const bytes = fs.get(path);
          if (!bytes) throw new Error(`not found: ${path}`);
          return bytes;
        }),
        decode,
      });
      await loadProject('/proj/round.oblique', loadDeps);

      expect(decode).toHaveBeenCalledWith(pngBytes);
      expect(cache.get('n1', 'baked')).toBeDefined();
    });
  });
});

describe('dirty-since-save tracking', () => {
  it('any scene mutation after load flips dirtySinceSave', async () => {
    await loadProject('/proj/x.oblique', makeDeps());
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);

    useSceneStore.getState().setModifierParam('n1', 'm1', 'radius', 9);
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(true);
  });
});

describe('newProject', () => {
  it('clean project: resets scene/path/caches/sources/history without prompting', async () => {
    await loadProject('/proj/x.oblique', makeDeps());
    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);

    const clearCache = vi.spyOn(cache, 'clearAll');
    const clearSources = vi.spyOn(sources, 'clearAll');
    const clearHistory = vi.spyOn(history, 'clear');
    const confirmDiscard = vi.fn();

    await newProject(confirmDiscard);

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
    expect(useProjectMetaStore.getState().path).toBeNull();
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);
    expect(clearCache).toHaveBeenCalled();
    expect(clearSources).toHaveBeenCalled();
    expect(clearHistory).toHaveBeenCalled();
  });

  it('dirty project: prompts, and a cancelled prompt leaves the scene untouched', async () => {
    await loadProject('/proj/x.oblique', makeDeps());
    useSceneStore.getState().setModifierParam('n1', 'm1', 'radius', 9);
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(true);

    const confirmDiscard = vi.fn(async () => false);
    await newProject(confirmDiscard);

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
  });

  it('dirty project: a confirmed prompt resets the scene', async () => {
    await loadProject('/proj/x.oblique', makeDeps());
    useSceneStore.getState().setModifierParam('n1', 'm1', 'radius', 9);

    const confirmDiscard = vi.fn(async () => true);
    await newProject(confirmDiscard);

    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });

  it('does not resurrect the discarded scene in undo history', async () => {
    await loadProject('/proj/x.oblique', makeDeps());
    await newProject(async () => true);

    const { undo } = await import('@/scene/history');
    await undo();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });
});

describe('openProjectDialog vs importImagesDialog (roadmap: split Open vs Import, 2026-07-05)', () => {
  it('openProjectDialog only accepts .oblique filters and loads the project, never imports', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    (open as ReturnType<typeof vi.fn>).mockResolvedValue('/proj/x.oblique');
    (readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(serialiseProject(sampleScene()));
    const importFilesSpy = vi.spyOn(importModule, 'importFiles');

    await openProjectDialog();

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'Oblique project', extensions: ['oblique'] }],
      }),
    );
    expect(useSceneStore.getState().scene.id).toBe('scene-1');
    expect(importFilesSpy).not.toHaveBeenCalled();
  });

  it('openProjectDialog does nothing when the dialog is cancelled', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await openProjectDialog();

    expect(useSceneStore.getState().scene.id).toBe('empty');
  });

  it('importImagesDialog adds node(s) via importFiles and never calls loadProject', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(['/pics/a.png']);
    const importFilesSpy = vi
      .spyOn(importModule, 'importFiles')
      .mockResolvedValue([{ path: '/pics/a.png', nodeId: 'n-new' }]);

    await importImagesDialog();

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
      }),
    );
    expect(importFilesSpy).toHaveBeenCalledWith(['/pics/a.png'], importModule.tauriImportDeps);
    // Still on the empty scene — importImagesDialog never swaps the project.
    expect(useSceneStore.getState().scene.id).toBe('empty');
  });

  it('importImagesDialog does nothing when the dialog is cancelled', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const importFilesSpy = vi.spyOn(importModule, 'importFiles');

    await importImagesDialog();

    expect(importFilesSpy).not.toHaveBeenCalled();
  });
});
