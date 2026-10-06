import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_NAME } from '@/branding';
import { firstDifference, normal } from '@/rhizome/adapter';
import { adoptRhizome, createRhizome, type Rhizome } from '@/rhizome/rhizome';
import { FakeHost } from '@/rhizome/testHost';
import * as backgroundSource from '@/scene/backgroundSource';
import { restoreScene } from '@/scene/restore';
import * as sources from '@/scene/sources';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';

vi.mock('@preset.nz/ux-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@preset.nz/ux-kit')>()),
  notify: vi.fn(),
  dismissNotification: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  remove: vi.fn(),
  writeFile: vi.fn(),
}));

import { notify } from '@preset.nz/ux-kit';
import * as cache from '@/scene/cache';
import * as prefixStore from '@/scene/prefixStore';
import * as importModule from './import';
import type { ProjectIoDeps } from './io';
import {
  attachDocumentOpening,
  importImagesDialog,
  loadProject,
  newProject,
  openProjectDialog,
  saveProject,
  setBackgroundImageFromPath,
  useProjectMetaStore,
  writeBakedSidecar,
} from './io';
import { bindProjectMeta } from './projectMeta';

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
        cameraId: null,
        modifiers: [{ id: 'm1', type: 'gaussian_blur', enabled: true, params: { radius: 3 } }],
        visible: true,
        blendMode: 'normal',
        opacity: 1,
        dirty: { draft: false, working: false },
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

const emptyScene = (): Scene => ({
  id: 'empty',
  nodes: [],
  cameras: [],
  defaultCameraId: null,
  resolution: 'working',
  documentSize: [0, 0],
});

function makeDeps(overrides: Partial<ProjectIoDeps> = {}): ProjectIoDeps {
  return {
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

// ---------------------------------------------------------------- the host under the tests

let host: FakeHost;
let rhizome: Rhizome;
let unbind: () => void;
let uninstall: () => void;
/** What the store's restore decodes with: each test's own deps, swapped in with `use`. */
let restoreDeps: ProjectIoDeps;

/** Puts `scene` in a file on the fake disk, as an earlier save would have. */
function putFile(path: string, scene: Scene): void {
  host.disk.set(path, FakeHost.fileOf(scene));
}

/** The open document and the store both hold `scene`; nothing is saved. */
async function arrange(scene: Scene): Promise<void> {
  host.rows = new FakeHost(scene).rows;
  await rhizome.rebuild();
}

async function startHost(): Promise<void> {
  restoreDeps = makeDeps();
  host = new FakeHost(emptyScene());
  rhizome = createRhizome({
    backend: host,
    store: useSceneStore,
    notify: (o) => notify(o),
    restore: (current, target) =>
      restoreScene(
        current,
        target,
        { readFile: (p) => restoreDeps.readFile(p), decode: (b) => restoreDeps.decode(b) },
        (scene) => useSceneStore.getState().loadScene(scene),
      ),
    nextFrame: async () => undefined,
    schedule: () => undefined, // the tests call reconcile themselves
  });
  adoptRhizome(rhizome);
  unbind = bindProjectMeta(rhizome);
  uninstall = rhizome.install();
  await rhizome.start([]);
  await settle();
}

/** Lets queued promise work and timers-of-zero run. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** `loadProject` with deps the store's restore shares, so one fake filesystem serves both. */
const use = (deps: ProjectIoDeps): ProjectIoDeps => {
  restoreDeps = deps;
  return deps;
};

beforeEach(async () => {
  useSceneStore.setState({ scene: emptyScene() });
  useProjectMetaStore.setState({ path: null, dirtySinceSave: false });
  sources.clearAll();
  backgroundSource.clear();
  cache.clearAll();
  vi.clearAllMocks();
  await startHost();
});

afterEach(() => {
  unbind();
  uninstall();
  adoptRhizome(null);
});

const sceneNow = () => useSceneStore.getState().scene;

describe('loadProject', () => {
  it('rebuilds the store from the opened document, rehydrates sources, marks nodes draft-dirty', async () => {
    putFile('/proj/x.oblique', sampleScene());
    const deps = use(makeDeps());
    await loadProject('/proj/x.oblique', deps);

    const scene = sceneNow();
    expect(firstDifference(normal(scene), normal(sampleScene()))).toBeNull();
    expect(scene.nodes[0].dirty).toEqual({ draft: true, working: true });
    expect(sources.get('n1')).toBeDefined();
    expect(sources.isSourceMissing('n1')).toBe(false);
    expect(useProjectMetaStore.getState().path).toBe('/proj/x.oblique');
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);
    // no reconcile diff afterwards
    expect(await rhizome.reconcile()).toBe('same');
  });

  it('reopening the open file keeps its node ids and still marks them dirty', async () => {
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    useSceneStore.getState().clearDirty('n1', 'draft');
    useSceneStore.getState().clearDirty('n1', 'working');
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(sceneNow().nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it("drops the previous project's prefix-cache state (prefix-cache.md)", async () => {
    putFile('/proj/x.oblique', sampleScene());
    prefixStore.setLastStack('stale-node', 'draft', ['x']);
    prefixStore.setPrefix('stale-node', 'draft', {
      descriptor: { source: 's', width: 1, height: 1, modifiers: ['x'] },
      bytes: new Uint8Array(4),
    });

    await loadProject('/proj/x.oblique', use(makeDeps()));

    expect(prefixStore.getLastStack('stale-node', 'draft')).toBeUndefined();
    expect(prefixStore.getPrefix('stale-node', 'draft')).toBeUndefined();
  });

  it('missing source file: node kept, flagged sourceMissing, path preserved', async () => {
    putFile('/proj/x.oblique', sampleScene());
    const deps = use(
      makeDeps({
        readFile: vi.fn(async () => {
          throw new Error('gone');
        }),
      }),
    );
    await loadProject('/proj/x.oblique', deps);

    const node = sceneNow().nodes[0];
    expect(node).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: pixel field access in test
    expect((node as any).sourcePath).toBe('/pics/a.png');
    expect(sources.isSourceMissing('n1')).toBe(true);
  });

  it("an old JSON project is refused with rhizome's own error: filename in the snackbar, nothing changes", async () => {
    host.disk.set(
      '/proj/old.oblique',
      JSON.stringify({ format: 'oblique-project', version: 2, scene: sampleScene() }),
    );
    // something in the open document and the caches that a failed open must not touch
    await arrange(sampleScene());
    const heldBefore = sources.get('n1');
    const deps = use(makeDeps());

    await loadProject('/proj/old.oblique', deps);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('old.oblique'),
        description: '/proj/old.oblique: not a rhizome document',
      }),
    );
    expect(sceneNow().nodes.map((n) => n.id)).toEqual(['n1']);
    expect(sources.get('n1')).toBe(heldBefore);
    expect(useProjectMetaStore.getState().path).toBeNull();
    expect(await rhizome.reconcile()).toBe('same');
  });

  it('a missing file is refused the same way', async () => {
    await loadProject('/proj/none.oblique', use(makeDeps()));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('none.oblique') }),
    );
    expect(sceneNow().id).toBe('empty');
  });

  describe('baked-bitmap rehydration (baked-persistence.md)', () => {
    function lockedScene() {
      const scene = sampleScene();
      scene.nodes[0].state = 'locked';
      return scene;
    }

    it('a locked node with a decodable sidecar PNG: cache populated, no cook needed', async () => {
      putFile('/proj/x.oblique', lockedScene());
      const readFile = vi.fn(async (path: string) => {
        if (path === '/proj/x.oblique.baked/n1.png') return new Uint8Array([9, 9]);
        return new Uint8Array([1]);
      });
      await loadProject('/proj/x.oblique', use(makeDeps({ readFile })));

      expect(readFile).toHaveBeenCalledWith('/proj/x.oblique.baked/n1.png');
      expect(cache.get('n1', 'baked')).toBeDefined();
    });

    it('missing sidecar PNG: non-fatal, cache slot left empty for the scheduler to recover', async () => {
      putFile('/proj/x.oblique', lockedScene());
      const deps = use(
        makeDeps({
          readFile: vi.fn(async (path: string) => {
            if (path === '/proj/x.oblique.baked/n1.png') throw new Error('ENOENT');
            return new Uint8Array([1]);
          }),
        }),
      );

      await expect(loadProject('/proj/x.oblique', deps)).resolves.not.toThrow();
      expect(cache.get('n1', 'baked')).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(sceneNow().nodes.map((n) => n.id)).toEqual(['n1']);
    });

    it('corrupt sidecar PNG: non-fatal, cache slot left empty', async () => {
      putFile('/proj/x.oblique', lockedScene());
      const deps = use(
        makeDeps({
          decode: vi.fn(async (bytes: Uint8Array) => {
            if (bytes.length === 2) throw new Error('bad PNG');
            return { width: 200, height: 100, close: vi.fn() };
          }),
          readFile: vi.fn(async (path: string) =>
            path.endsWith('.baked/n1.png') ? new Uint8Array([9, 9]) : new Uint8Array([1]),
          ),
        }),
      );

      await expect(loadProject('/proj/x.oblique', deps)).resolves.not.toThrow();
      expect(cache.get('n1', 'baked')).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
    });

    it('save then load round-trip: the bytes this save wrote are exactly what the next load decodes', async () => {
      // A fake filesystem — just enough to make save's writeFile output
      // reachable by load's readFile, the way a real disk would.
      const fs = new Map<string, Uint8Array>();
      await arrange(lockedScene());
      cache.set('n1', 'baked', fakeBitmap());
      const pngBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

      const { save } = await import('@tauri-apps/plugin-dialog');
      (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/proj/round.oblique');
      await saveProject(
        { as: true },
        makeDeps({
          writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
            fs.set(path, bytes);
          }),
          encodePng: vi.fn(async () => pngBytes),
        }),
      );
      expect(fs.get('/proj/round.oblique.baked/n1.png')).toEqual(pngBytes);

      // Reset the cache the way a real reopen would find it (nothing in
      // memory) — the round-trip has to come entirely from `fs`.
      cache.clearAll();

      const decode = vi.fn(async () => ({ width: 200, height: 100, close: vi.fn() }));
      await loadProject(
        '/proj/round.oblique',
        use(
          makeDeps({
            readFile: vi.fn(async (path: string) => {
              const bytes = fs.get(path);
              if (!bytes) throw new Error(`not found: ${path}`);
              return bytes;
            }),
            decode,
          }),
        ),
      );

      expect(decode).toHaveBeenCalledWith(pngBytes);
      expect(cache.get('n1', 'baked')).toBeDefined();
    });
  });
});

describe('save, open and new over the document host', () => {
  it('new -> edits -> save -> open: the same scene, and no reconcile diff', async () => {
    await newProject(async () => true);
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);

    const store = useSceneStore.getState();
    store.setDocumentSize([640, 480]);
    const a = store.addPixelNode({ sourcePath: '/pics/a.png', sourceSize: [640, 480] });
    const b = store.addVectorNode({
      paths: [{ anchors: [{ point: { x: 1, y: 2 } }], closed: false }],
      fillRule: 'nonzero',
    });
    useSceneStore.getState().setNodeTransform(a, {
      x: 5,
      y: 6,
      scaleX: 2,
      scaleY: 2,
      rotation: 0.5,
    });
    useSceneStore.getState().setNodeProp(b, { opacity: 0.4, blendMode: 'multiply' });
    const t = useSceneStore.getState().addTextNode({
      content: 'Hi',
      font: {
        family: 'Inter',
        style: 'Regular',
        postscriptName: 'Inter-Regular',
        weight: 400,
        italic: false,
        category: 'sans',
      },
      position: { x: 10, y: 20 },
    });
    useSceneStore.getState().setTextProps(t, { content: 'Hi there', fill: '#ff8800' });
    await settle();
    expect(await rhizome.reconcile()).toBe('same');
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(true);
    const before = sceneNow();

    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/art/piece.oblique');
    await saveProject({}, use(makeDeps()));
    expect(notify).not.toHaveBeenCalled();
    expect(host.disk.has('/art/piece.oblique')).toBe(true);
    expect(useProjectMetaStore.getState()).toMatchObject({
      path: '/art/piece.oblique',
      dirtySinceSave: false,
    });

    await newProject(async () => true);
    expect(sceneNow().nodes).toHaveLength(0);
    expect(useProjectMetaStore.getState().path).toBeNull();

    await loadProject('/art/piece.oblique', use(makeDeps()));
    expect(firstDifference(normal(sceneNow()), normal(before))).toBeNull();
    expect(await rhizome.reconcile()).toBe('same');
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);
  });

  it('plain Save with a path runs file.save and asks for no dialog; the extension is rhizomes to add', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/art/noext');
    await arrange(sampleScene());
    await saveProject({}, use(makeDeps()));
    expect(useProjectMetaStore.getState().path).toBe('/art/noext.oblique');
    expect(host.disk.has('/art/noext.oblique')).toBe(true);

    (save as ReturnType<typeof vi.fn>).mockClear();
    host.trace.length = 0;
    await saveProject({}, use(makeDeps()));
    expect(save).not.toHaveBeenCalled();
    expect(host.trace).toContain('run:file.save');
  });

  it('a cancelled save dialog does nothing', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await saveProject({}, use(makeDeps()));
    expect(host.disk.size).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a host that refuses the write is a snackbar, not a crash', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/art/x.oblique');
    host.saveAs = async () => {
      throw 'permission denied';
    };
    await saveProject({}, use(makeDeps()));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        message: "Couldn't save project",
        description: 'permission denied',
      }),
    );
  });

  it('no host (outside the app): a snackbar, not a crash', async () => {
    adoptRhizome(null);
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('a macOS open goes through the same path as Cmd+O: at launch and while running', async () => {
    putFile('/proj/launch.oblique', sampleScene());
    host.launchPath = '/proj/launch.oblique';
    // a fresh connect hands the launch path over; the app's onLive then opens it
    const r2 = createRhizome({
      backend: host,
      store: useSceneStore,
      notify: (o) => notify(o),
      restore: async (_c, t) => useSceneStore.getState().loadScene(t),
      nextFrame: async () => undefined,
      schedule: () => undefined,
    });
    // the first instance steps down: this tests `attachDocumentOpening` and nothing else
    unbind();
    uninstall();
    adoptRhizome(r2);
    unbind = bindProjectMeta(r2);
    await r2.start([]);
    await attachDocumentOpening(r2);
    await settle();
    expect(sceneNow().nodes.map((n) => n.id)).toEqual(['n1']);
    expect(useProjectMetaStore.getState().path).toBe('/proj/launch.oblique');

    const second = { ...sampleScene(), nodes: [] };
    putFile('/proj/second.oblique', second);
    host.offerOpen('/proj/second.oblique');
    await settle();
    expect(sceneNow().nodes).toHaveLength(0);
    expect(useProjectMetaStore.getState().path).toBe('/proj/second.oblique');
  });
});

describe('the project meta store follows the status of the document host', () => {
  it('a new document is not unsaved; an edit, undo and redo are; a save is not; new has no path', async () => {
    const meta = () => useProjectMetaStore.getState();
    expect(meta()).toMatchObject({ path: null, dirtySinceSave: false });

    useSceneStore.getState().addPixelNode({ sourcePath: '/pics/a.png', sourceSize: [10, 10] });
    await settle();
    expect(meta().dirtySinceSave).toBe(true);

    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/art/m.oblique');
    await saveProject({}, use(makeDeps()));
    expect(meta()).toMatchObject({ path: '/art/m.oblique', dirtySinceSave: false });

    await rhizome.undo();
    await settle();
    expect(meta().dirtySinceSave).toBe(true);

    await newProject(async () => true);
    expect(meta()).toMatchObject({ path: null, dirtySinceSave: false });
  });

  it('scene churn that is not an edit (a cook clearing its dirty flag) does not mark it unsaved', async () => {
    await arrange(sampleScene());
    useSceneStore.getState().markDirty('n1', 'draft');
    useSceneStore.getState().clearDirty('n1', 'draft');
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);
  });
});

describe('newProject', () => {
  it('clean project: replaces the document and clears caches/sources without prompting', async () => {
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(sceneNow().nodes).toHaveLength(1);

    const clearCache = vi.spyOn(cache, 'clearAll');
    const clearSources = vi.spyOn(sources, 'clearAll');
    const confirmDiscard = vi.fn();

    await newProject(confirmDiscard);

    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(sceneNow().nodes).toHaveLength(0);
    expect(useProjectMetaStore.getState().path).toBeNull();
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);
    expect(clearCache).toHaveBeenCalled();
    expect(clearSources).toHaveBeenCalled();
    expect(await rhizome.reconcile()).toBe('same');
  });

  it('clears prefix-cache state (prefix-cache.md)', async () => {
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    prefixStore.setLastStack('n1', 'draft', ['x']);

    await newProject(vi.fn());

    expect(prefixStore.getLastStack('n1', 'draft')).toBeUndefined();
  });

  it('dirty project: prompts, and a cancelled prompt leaves the document untouched', async () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/pics/a.png', sourceSize: [10, 10] });
    await settle();
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(true);

    const confirmDiscard = vi.fn(async () => false);
    await newProject(confirmDiscard);

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(sceneNow().nodes).toHaveLength(1);
  });

  it('dirty project: a confirmed prompt starts the new document', async () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/pics/a.png', sourceSize: [10, 10] });
    await settle();

    const confirmDiscard = vi.fn(async () => true);
    await newProject(confirmDiscard);

    expect(sceneNow().nodes).toHaveLength(0);
  });

  it('does not resurrect the discarded scene in undo', async () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/pics/a.png', sourceSize: [10, 10] });
    await settle();
    await newProject(async () => true);

    const { undo } = await import('@/scene/history');
    await undo();
    expect(sceneNow().nodes).toHaveLength(0);
  });
});

describe('document background image (background-image.md)', () => {
  const imageBackground = {
    type: 'image',
    sourcePath: '/pics/bg.png',
    sourceSize: [60, 40],
  } as const;

  function sceneWithImage(): Scene {
    const scene = sampleScene();
    scene.background = { ...imageBackground, sourceSize: [60, 40] };
    return scene;
  }

  it('loadProject re-decodes the background from sourcePath', async () => {
    putFile('/proj/x.oblique', sceneWithImage());
    const deps = use(makeDeps());
    await loadProject('/proj/x.oblique', deps);
    expect(deps.readFile).toHaveBeenCalledWith('/pics/bg.png');
    expect(backgroundSource.get('/pics/bg.png')).toBeDefined();
    expect(backgroundSource.useBackgroundSourceStore.getState().missing).toBe(false);
  });

  it('a missing/unreadable background source degrades like a missing pixel source: no crash, path kept, flagged missing', async () => {
    putFile('/proj/x.oblique', sceneWithImage());
    const deps = use(
      makeDeps({
        readFile: vi.fn(async (path: string) => {
          if (path === '/pics/bg.png') throw new Error('gone');
          return new Uint8Array([1]);
        }),
      }),
    );
    await loadProject('/proj/x.oblique', deps);

    expect(sceneNow().background).toEqual({ ...imageBackground, sourceSize: [60, 40] });
    expect(backgroundSource.heldPath()).toBeUndefined();
    expect(backgroundSource.useBackgroundSourceStore.getState().missing).toBe(true);
    expect(sources.isSourceMissing('n1')).toBe(false); // the pixel node itself was fine
  });

  it('opening a project without an image background drops a previously held bitmap', async () => {
    putFile('/proj/x.oblique', sampleScene());
    backgroundSource.set('/old.png', fakeBitmap());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(backgroundSource.heldPath()).toBeUndefined();
  });

  it('File -> New drops the held bitmap', async () => {
    backgroundSource.set('/old.png', fakeBitmap());
    await newProject(async () => true);
    expect(backgroundSource.heldPath()).toBeUndefined();
  });

  it('setBackgroundImageFromPath holds the bitmap and sets the scene background; decode failure raises a snackbar and changes nothing', async () => {
    uninstall(); // the store's own action, as outside the app: the wrapper refuses it
    const decode = vi.fn(async () => ({ width: 60, height: 40, close: vi.fn() }));
    const ok = await setBackgroundImageFromPath('/pics/bg.png', {
      readFile: vi.fn(async () => new Uint8Array([1])),
      decode,
    });
    expect(ok).toBe(true);
    expect(backgroundSource.get('/pics/bg.png')).toBeDefined();
    expect(sceneNow().background).toEqual({
      type: 'image',
      sourcePath: '/pics/bg.png',
      sourceSize: [60, 40],
    });

    const failed = await setBackgroundImageFromPath('/pics/bad.png', {
      readFile: vi.fn(async () => new Uint8Array([1])),
      decode: vi.fn(async () => {
        throw new Error('corrupt');
      }),
    });
    expect(failed).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sceneNow().background).toMatchObject({ sourcePath: '/pics/bg.png' });
    expect(backgroundSource.get('/pics/bg.png')).toBeDefined();
  });

  it('on rhizome it is refused BEFORE the file is read or decoded: a toast, no bitmap held, no background', async () => {
    const readFile = vi.fn(async () => new Uint8Array([1]));
    const decode = vi.fn(async () => ({ width: 60, height: 40, close: vi.fn() }));
    const ok = await setBackgroundImageFromPath('/pics/bg.png', { readFile, decode });

    expect(ok).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(backgroundSource.heldPath()).toBeUndefined();
    expect(sceneNow().background).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }));
  });
});

describe('writeBakedSidecar', () => {
  it('no locked nodes: never touches the baked sidecar dir', async () => {
    const deps = makeDeps();
    await writeBakedSidecar('/proj/x.oblique', sampleScene(), deps);

    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('locked node with a baked bitmap: writes exactly one PNG named after the node id', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    cache.set('n1', 'baked', fakeBitmap());
    const deps = makeDeps();

    await writeBakedSidecar('/proj/x.oblique', scene, deps);

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

    await writeBakedSidecar('/proj/x.oblique', scene, deps);

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

    await expect(writeBakedSidecar('/proj/x.oblique', scene, deps)).resolves.not.toThrow();
    expect(deps.writeFile).not.toHaveBeenCalled();
    // Nothing survives (freshly mkdir'd, nothing written, nothing pre-existing) — cleaned up.
    expect(deps.remove).toHaveBeenCalledWith('/proj/x.oblique.baked', { recursive: true });
  });

  it('unlock then save: the stale PNG is swept from the dir', async () => {
    const scene = sampleScene(); // n1 active
    const deps = makeDeps({ readDir: vi.fn(async () => [{ name: 'n1.png' }]) });

    scene.nodes.push({ ...scene.nodes[0], id: 'n2', state: 'locked' });
    cache.set('n2', 'baked', fakeBitmap());

    await writeBakedSidecar('/proj/x.oblique', scene, deps);

    expect(deps.remove).toHaveBeenCalledWith('/proj/x.oblique.baked/n1.png', undefined);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/proj/x.oblique.baked/n2.png',
      expect.any(Uint8Array),
    );
  });

  it('unlock the only locked node then save: the whole dir is removed', async () => {
    const deps = makeDeps();

    await writeBakedSidecar('/proj/x.oblique', sampleScene(), deps);

    expect(deps.remove).toHaveBeenCalledWith('/proj/x.oblique.baked', { recursive: true });
    expect(deps.mkdir).not.toHaveBeenCalled();
  });

  it('save-as: writes a fresh dir beside the new path, leaves the old one untouched', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    cache.set('n1', 'baked', fakeBitmap());
    const deps = makeDeps();

    await writeBakedSidecar('/proj/new.oblique', scene, deps);

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

describe('openProjectDialog vs importImagesDialog (roadmap: split Open vs Import, 2026-07-05)', () => {
  it('openProjectDialog only accepts .oblique filters and loads the project, never imports', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    (open as ReturnType<typeof vi.fn>).mockResolvedValue('/proj/x.oblique');
    putFile('/proj/x.oblique', sampleScene());
    const importFilesSpy = vi.spyOn(importModule, 'importFiles');

    await openProjectDialog();

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: `${PRODUCT_NAME} project`, extensions: ['oblique'] }],
      }),
    );
    expect(sceneNow().nodes.map((n) => n.id)).toEqual(['n1']);
    expect(importFilesSpy).not.toHaveBeenCalled();
  });

  it('openProjectDialog does nothing when the dialog is cancelled', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await openProjectDialog();

    expect(sceneNow().id).toBe('empty');
  });

  it('importImagesDialog adds node(s) via importFiles and never opens a project', async () => {
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
    expect(sceneNow().id).toBe('empty');
  });

  it('importImagesDialog does nothing when the dialog is cancelled', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const importFilesSpy = vi.spyOn(importModule, 'importFiles');

    await importImagesDialog();

    expect(importFilesSpy).not.toHaveBeenCalled();
  });
});

describe('relative source paths (image-source.md)', () => {
  function relativeScene(sourcePath: string, sourceSize: [number, number] = [200, 100]): Scene {
    const scene = sampleScene();
    // biome-ignore lint/suspicious/noExplicitAny: PixelNode via SceneNode[] slot
    const node = scene.nodes[0] as any;
    node.sourcePath = sourcePath;
    node.sourceSize = sourceSize;
    return scene;
  }

  it('loadProject resolves a relative path against the project folder and keeps it verbatim', async () => {
    putFile('/x/proj.oblique', relativeScene('plates/a.png'));
    const readFile = vi.fn(async () => new Uint8Array([1]));
    await loadProject('/x/proj.oblique', use(makeDeps({ readFile })));
    expect(readFile).toHaveBeenCalledWith('/x/plates/a.png');
    expect(sources.isSourceMissing('n1')).toBe(false);
    expect((sceneNow().nodes[0] as unknown as { sourcePath: string }).sourcePath).toBe(
      'plates/a.png',
    );
  });

  it('loadProject flags a hand-edited strata:// path missing without reading anything', async () => {
    putFile('/x/proj.oblique', relativeScene('strata://asset/1'));
    const readFile = vi.fn(async () => new Uint8Array([1]));
    await loadProject('/x/proj.oblique', use(makeDeps({ readFile })));
    expect(sources.isSourceMissing('n1')).toBe(true);
    expect(sources.missingReason('n1')).toBe('unsupported-scheme');
    expect(readFile).not.toHaveBeenCalledWith('strata://asset/1');
    expect(sceneNow().nodes).toHaveLength(1); // never deleted
  });

  it('a first Save re-checks relative paths: flagged missing before, resolved after; the node is not refitted', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/x/proj.oblique');
    await arrange(relativeScene('plates/a.png', [200, 100]));
    sources.useSourceMissingStore.getState().setMissing('n1', true, 'relative-unsaved');

    const readFile = vi.fn(async () => new Uint8Array([1]));
    const decode = vi.fn(async () => ({ width: 400, height: 100, close: vi.fn() }));
    await saveProject({}, use(makeDeps({ readFile, decode })));

    expect(readFile).toHaveBeenCalledWith('/x/plates/a.png');
    expect(sources.isSourceMissing('n1')).toBe(false);
    const node = sceneNow().nodes[0] as unknown as {
      sourcePath: string;
      sourceSize: [number, number];
    };
    expect(node.sourcePath).toBe('plates/a.png');
    // deferred: Epic 21 story 2 — the refit to the file's own size is a write rhizome doesn't carry yet
    expect(node.sourceSize).toEqual([200, 100]);
    expect(notify).not.toHaveBeenCalled(); // no "isn't on rhizome yet" toast for bookkeeping
    expect(useProjectMetaStore.getState().path).toBe('/x/proj.oblique');
    expect(useProjectMetaStore.getState().dirtySinceSave).toBe(false);
  });

  it('Save As to another folder re-checks: a relative path that no longer resolves is flagged', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/y/copy.oblique');
    putFile('/x/proj.oblique', relativeScene('plates/a.png'));
    await loadProject('/x/proj.oblique', use(makeDeps()));
    expect(sources.isSourceMissing('n1')).toBe(false);

    const readFile = vi.fn(async (path: string) => {
      if (path === '/y/plates/a.png') throw new Error('ENOENT');
      return new Uint8Array([1]);
    });
    await saveProject({ as: true }, use(makeDeps({ readFile })));

    expect(readFile).toHaveBeenCalledWith('/y/plates/a.png');
    expect(sources.isSourceMissing('n1')).toBe(true);
    expect(sources.missingReason('n1')).toBe('not-found');
  });

  it('absolute paths are not re-read on Save As', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    putFile('/x/proj.oblique', sampleScene()); // /pics/a.png
    await loadProject('/x/proj.oblique', use(makeDeps()));
    (save as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/y/copy.oblique');
    const readFile = vi.fn(async () => new Uint8Array([1]));
    await saveProject({ as: true }, use(makeDeps({ readFile })));
    expect(readFile).not.toHaveBeenCalled();
  });
});
