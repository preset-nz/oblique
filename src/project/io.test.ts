import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMissingFontsStore } from '@/fonts/missingFonts';
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
  importImagesDialog,
  projectDocumentEvents,
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
    events: projectDocumentEvents(restoreProxy),
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

/** The project's side of opening and saving, over whatever deps the test has swapped in. */
const restoreProxy: ProjectIoDeps = {
  readFile: (p) => restoreDeps.readFile(p),
  decode: (b) => restoreDeps.decode(b),
  mkdir: (p, o) => restoreDeps.mkdir(p, o),
  writeFile: (p, b) => restoreDeps.writeFile(p, b),
  readDir: (p) => restoreDeps.readDir(p),
  remove: (p, o) => restoreDeps.remove(p, o),
  encodePng: (b) => restoreDeps.encodePng(b),
};

/** Deps the store's restore and the project's events share, so one fake filesystem serves both. */
const use = (deps: ProjectIoDeps): ProjectIoDeps => {
  restoreDeps = deps;
  return deps;
};

/** File > Open (or Open Recent, Revert, a Finder open) as app-kit does it, and the webview's side of it. */
const loadProject = async (path: string, deps: ProjectIoDeps): Promise<void> => {
  use(deps);
  await host.openFile(path);
};

/** File > Save or Save As… as app-kit does it, and the webview's side of it. */
const saveProject = async (path: string, deps: ProjectIoDeps): Promise<void> => {
  use(deps);
  await host.saveFile(path);
};

beforeEach(async () => {
  useSceneStore.setState({ scene: emptyScene() });
  useProjectMetaStore.setState({ path: null });
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

describe('a document opened from Rust (document-opened)', () => {
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

  it("an old JSON project is refused (app-kit shows rhizome's error): nothing changes, nothing is heard", async () => {
    host.disk.set(
      '/proj/old.oblique',
      JSON.stringify({ format: 'oblique-project', version: 2, scene: sampleScene() }),
    );
    // something in the open document and the caches that a failed open must not touch
    await arrange(sampleScene());
    const heldBefore = sources.get('n1');
    const deps = use(makeDeps());

    await expect(loadProject('/proj/old.oblique', deps)).rejects.toBe(
      '/proj/old.oblique: not a rhizome document',
    );

    expect(notify).not.toHaveBeenCalled();
    expect(sceneNow().nodes.map((n) => n.id)).toEqual(['n1']);
    expect(sources.get('n1')).toBe(heldBefore);
    expect(useProjectMetaStore.getState().path).toBeNull();
    expect(await rhizome.reconcile()).toBe('same');
  });

  it('a missing file is refused the same way', async () => {
    await expect(loadProject('/proj/none.oblique', use(makeDeps()))).rejects.toBeDefined();
    expect(notify).not.toHaveBeenCalled();
    expect(sceneNow().id).toBe('empty');
  });

  it('the issues a load reports are one warning naming the file; none is no toast', async () => {
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(notify).not.toHaveBeenCalled();

    host.issues = [
      { path: '/layers/n1', message: 'one thing' },
      { path: '/layers/n1', message: 'another' },
    ];
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: 'warning',
      message: 'x.oblique opened with 2 issues',
      description: 'one thing\nanother',
    });
  });

  it('warns about missing fonts for an opened file, and clears the warning for New', async () => {
    const fonts = useMissingFontsStore.getState();
    const opened = vi.spyOn(fonts, 'documentOpened');
    const cleared = vi.spyOn(fonts, 'documentCleared');
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(cleared).not.toHaveBeenCalled();

    await host.newFile();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
    opened.mockRestore();
    cleared.mockRestore();
  });

  it('clears the caches first, and reads the baked bitmaps BEFORE the scene reaches the store', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    putFile('/proj/x.oblique', scene);
    cache.set('stale', 'baked', fakeBitmap());
    const bakedWhenSceneArrived: (boolean | 'n/a')[] = [];
    const unsubscribe = useSceneStore.subscribe((state, previous) => {
      if (state.scene === previous.scene) return;
      bakedWhenSceneArrived.push(
        state.scene.nodes.some((n) => n.id === 'n1')
          ? cache.get('n1', 'baked') !== undefined
          : 'n/a',
      );
    });
    const readFile = vi.fn(async () => new Uint8Array([1]));

    await loadProject('/proj/x.oblique', use(makeDeps({ readFile })));
    unsubscribe();

    expect(cache.get('stale', 'baked')).toBeUndefined();
    // every time the store gained n1, its baked bitmap was already there
    expect(bakedWhenSceneArrived).toContain(true);
    expect(bakedWhenSceneArrived).not.toContain(false);
    expect(await rhizome.reconcile()).toBe('same');
  });

  it('a file held until the catalogue arrives (relaunch restore, a cold Finder open) opens the same way', async () => {
    // a fresh host, as at launch: the file is applied during init
    unbind();
    uninstall();
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    useSceneStore.setState({ scene: emptyScene() });
    cache.clearAll();
    const deps = use(makeDeps());
    host = new FakeHost(emptyScene());
    host.disk.set('/proj/restored.oblique', FakeHost.fileOf(scene));
    host.heldOpen = '/proj/restored.oblique';
    rhizome = createRhizome({
      backend: host,
      store: useSceneStore,
      notify: (o) => notify(o),
      restore: (current, target) =>
        restoreScene(
          current,
          target,
          { readFile: (p) => restoreDeps.readFile(p), decode: (b) => restoreDeps.decode(b) },
          (loaded) => useSceneStore.getState().loadScene(loaded),
        ),
      events: projectDocumentEvents(restoreProxy),
      nextFrame: async () => undefined,
      schedule: () => undefined,
    });
    adoptRhizome(rhizome);
    unbind = bindProjectMeta(rhizome);
    uninstall = rhizome.install();
    await rhizome.start([]);
    await settle();

    expect(deps.readFile).toHaveBeenCalledWith('/proj/restored.oblique.baked/n1.png');
    expect(cache.get('n1', 'baked')).toBeDefined();
    expect(sceneNow().nodes.map((n) => n.id)).toEqual(['n1']);
    expect(sceneNow().nodes[0].dirty).toEqual({ draft: true, working: true });
    expect(useProjectMetaStore.getState().path).toBe('/proj/restored.oblique');
    expect(await rhizome.reconcile()).toBe('same');
    expect(host.messages.filter((m) => m.startsWith('reconcile:'))).toEqual([]);
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

      await saveProject(
        '/proj/round.oblique',
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
  it('new -> edits -> save -> new -> open: the same scene, and no reconcile diff', async () => {
    await host.newFile();

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
    const before = sceneNow();

    await saveProject('/art/piece.oblique', use(makeDeps()));
    expect(notify).not.toHaveBeenCalled();
    expect(host.disk.has('/art/piece.oblique')).toBe(true);
    expect(useProjectMetaStore.getState().path).toBe('/art/piece.oblique');

    await host.newFile();
    expect(sceneNow().nodes).toHaveLength(0);
    expect(useProjectMetaStore.getState().path).toBeNull();

    await loadProject('/art/piece.oblique', use(makeDeps()));
    expect(firstDifference(normal(sceneNow()), normal(before))).toBeNull();
    expect(await rhizome.reconcile()).toBe('same');
  });

  it('a save writes the baked bitmaps beside the file it names, and a repeat save does too', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    await arrange(scene);
    cache.set('n1', 'baked', fakeBitmap());
    const deps = makeDeps();

    await saveProject('/art/a.oblique', use(deps));
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/art/a.oblique.baked/n1.png',
      expect.any(Uint8Array),
    );

    await saveProject('/art/a.oblique', use(deps));
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
  });

  it('a baked bitmap that will not write is a snackbar, and the save itself stands', async () => {
    const scene = sampleScene();
    scene.nodes[0].state = 'locked';
    await arrange(scene);
    cache.set('n1', 'baked', fakeBitmap());
    const deps = makeDeps({
      writeFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    await saveProject('/art/a.oblique', use(deps));

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', description: 'disk full' }),
    );
    expect(host.disk.has('/art/a.oblique')).toBe(true);
  });
});

describe('the project meta store follows the status of the document host', () => {
  it('a save gives it the path, New takes it away, and an open sets it', async () => {
    const meta = () => useProjectMetaStore.getState();
    expect(meta()).toMatchObject({ path: null });

    useSceneStore.getState().addPixelNode({ sourcePath: '/pics/a.png', sourceSize: [10, 10] });
    await settle();
    expect(meta().path).toBeNull();

    await saveProject('/art/m.oblique', use(makeDeps()));
    expect(meta().path).toBe('/art/m.oblique');

    await host.newFile();
    expect(meta().path).toBeNull();

    await loadProject('/art/m.oblique', use(makeDeps()));
    expect(meta().path).toBe('/art/m.oblique');
  });
});

describe('File > New', () => {
  it('replaces the document and clears caches and sources', async () => {
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    expect(sceneNow().nodes).toHaveLength(1);

    const clearCache = vi.spyOn(cache, 'clearAll');
    const clearSources = vi.spyOn(sources, 'clearAll');

    await host.newFile();

    expect(sceneNow().nodes).toHaveLength(0);
    expect(useProjectMetaStore.getState().path).toBeNull();
    expect(clearCache).toHaveBeenCalled();
    expect(clearSources).toHaveBeenCalled();
    expect(await rhizome.reconcile()).toBe('same');
  });

  it('clears prefix-cache state (prefix-cache.md)', async () => {
    putFile('/proj/x.oblique', sampleScene());
    await loadProject('/proj/x.oblique', use(makeDeps()));
    prefixStore.setLastStack('n1', 'draft', ['x']);

    await host.newFile();

    expect(prefixStore.getLastStack('n1', 'draft')).toBeUndefined();
  });

  it('does not resurrect the discarded scene in undo', async () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/pics/a.png', sourceSize: [10, 10] });
    await settle();
    await host.newFile();

    await host.step(true); // Edit > Undo: the new document starts an empty history
    await settle();
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

  it('an opened file re-decodes the background from sourcePath', async () => {
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
    await host.newFile();
    expect(backgroundSource.heldPath()).toBeUndefined();
  });

  it('setBackgroundImageFromPath holds the bitmap and sends the background to rhizome; decode failure raises a snackbar and changes nothing', async () => {
    const decode = vi.fn(async () => ({ width: 60, height: 40, close: vi.fn() }));
    const ok = await setBackgroundImageFromPath('/pics/bg.png', {
      readFile: vi.fn(async () => new Uint8Array([1])),
      decode,
    });
    expect(ok).toBe(true);
    expect(backgroundSource.get('/pics/bg.png')).toBeDefined();
    const wanted = { type: 'image', sourcePath: '/pics/bg.png', sourceSize: [60, 40] };
    expect(sceneNow().background).toEqual(wanted);
    await settle();
    expect(host.runs.map((r) => ({ id: r.id, payload: r.payload }))).toEqual([
      { id: 'document.set_background', payload: { background: wanted } },
    ]);
    expect(await rhizome.reconcile()).toBe('same');

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
    await settle();
    expect(host.runs).toHaveLength(1); // the failed pick sent nothing
  });

  it('a saved image background comes back on open: re-decoded from its path', async () => {
    await setBackgroundImageFromPath('/pics/bg.png', {
      readFile: vi.fn(async () => new Uint8Array([1])),
      decode: vi.fn(async () => ({ width: 60, height: 40, close: vi.fn() })),
    });
    await settle();
    await saveProject('/art/bg.oblique', use(makeDeps()));
    backgroundSource.clear();
    const decode = vi.fn(async () => ({ width: 60, height: 40, close: vi.fn() }));
    await loadProject('/art/bg.oblique', use(makeDeps({ decode })));
    expect(sceneNow().background).toMatchObject({ type: 'image', sourcePath: '/pics/bg.png' });
    expect(backgroundSource.heldPath()).toBe('/pics/bg.png');
    expect(decode).toHaveBeenCalled();
  });
});

describe('lock, save and reopen (layer.set_state)', () => {
  it('a layer locked in the app is saved with its bake and comes back locked, showing the bake', async () => {
    const fs = new Map<string, Uint8Array>();
    await arrange(sampleScene());
    await useSceneStore.getState().lockNode('n1', async () => fakeBitmap());
    await settle();
    expect(host.runs.map((r) => r.id)).toEqual(['layer.set_state']);

    const pngBytes = new Uint8Array([137, 80, 78, 71, 9]);
    await saveProject(
      '/proj/locked.oblique',
      makeDeps({
        writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
          fs.set(path, bytes);
        }),
        encodePng: vi.fn(async () => pngBytes),
      }),
    );
    expect(fs.get('/proj/locked.oblique.baked/n1.png')).toEqual(pngBytes);

    cache.clearAll();
    useSceneStore.setState({ scene: emptyScene() });
    await loadProject(
      '/proj/locked.oblique',
      use(
        makeDeps({
          readFile: vi.fn(async (path: string) => {
            const bytes = fs.get(path);
            if (!bytes) throw new Error(`not found: ${path}`);
            return bytes;
          }),
        }),
      ),
    );
    expect(sceneNow().nodes[0].state).toBe('locked');
    expect(cache.get('n1', 'baked')).toBeDefined(); // the bake came from the file, not a cook
    expect(await rhizome.reconcile()).toBe('same');
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

describe('importImagesDialog (roadmap: split Open vs Import, 2026-07-05)', () => {
  it('importImagesDialog adds node(s) via importFiles and never replaces the project', async () => {
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

  it('an opened file resolves a relative path against the project folder and keeps it verbatim', async () => {
    putFile('/x/proj.oblique', relativeScene('plates/a.png'));
    const readFile = vi.fn(async () => new Uint8Array([1]));
    await loadProject('/x/proj.oblique', use(makeDeps({ readFile })));
    expect(readFile).toHaveBeenCalledWith('/x/plates/a.png');
    expect(sources.isSourceMissing('n1')).toBe(false);
    expect((sceneNow().nodes[0] as unknown as { sourcePath: string }).sourcePath).toBe(
      'plates/a.png',
    );
  });

  it('an opened file flags a hand-edited strata:// path missing without reading anything', async () => {
    putFile('/x/proj.oblique', relativeScene('strata://asset/1'));
    const readFile = vi.fn(async () => new Uint8Array([1]));
    await loadProject('/x/proj.oblique', use(makeDeps({ readFile })));
    expect(sources.isSourceMissing('n1')).toBe(true);
    expect(sources.missingReason('n1')).toBe('unsupported-scheme');
    expect(readFile).not.toHaveBeenCalledWith('strata://asset/1');
    expect(sceneNow().nodes).toHaveLength(1); // never deleted
  });

  it('a first Save re-checks relative paths: flagged missing before, resolved after; a different size sends layer.set_source', async () => {
    await arrange(relativeScene('plates/a.png', [200, 100]));
    sources.useSourceMissingStore.getState().setMissing('n1', true, 'relative-unsaved');

    const readFile = vi.fn(async () => new Uint8Array([1]));
    const decode = vi.fn(async () => ({ width: 400, height: 100, close: vi.fn() }));
    await saveProject('/x/proj.oblique', use(makeDeps({ readFile, decode })));
    await vi.waitFor(() => expect(host.runs.map((r) => r.id)).toContain('layer.set_source'));

    expect(readFile).toHaveBeenCalledWith('/x/plates/a.png');
    expect(sources.isSourceMissing('n1')).toBe(false);
    expect(host.runs.find((r) => r.id === 'layer.set_source')?.payload).toEqual({
      at: '/layers/n1',
      sourcePath: 'plates/a.png',
      sourceSize: [400, 100],
    });
    await vi.waitFor(() =>
      expect((sceneNow().nodes[0] as unknown as { sourceSize: number[] }).sourceSize).toEqual([
        400, 100,
      ]),
    );
    const node = sceneNow().nodes[0] as unknown as { sourcePath: string };
    expect(node.sourcePath).toBe('plates/a.png');
    expect(notify).not.toHaveBeenCalled();
    expect(useProjectMetaStore.getState().path).toBe('/x/proj.oblique');
    // a real undo step, so the document is unsaved straight after the save that caused it
    expect(host.unsaved).toBe(true);
  });

  it('a first Save leaves a file of the same size alone: no command, still saved', async () => {
    await arrange(relativeScene('plates/a.png', [200, 100]));
    sources.useSourceMissingStore.getState().setMissing('n1', true, 'relative-unsaved');
    await saveProject('/x/proj.oblique', use(makeDeps())); // decodes 200x100
    expect(sources.isSourceMissing('n1')).toBe(false);
    expect(host.runs).toEqual([]); // a save is not a command run
    expect(host.unsaved).toBe(false);
  });

  it('Save As to another folder re-checks: a relative path that no longer resolves is flagged', async () => {
    putFile('/x/proj.oblique', relativeScene('plates/a.png'));
    await loadProject('/x/proj.oblique', use(makeDeps()));
    expect(sources.isSourceMissing('n1')).toBe(false);

    const readFile = vi.fn(async (path: string) => {
      if (path === '/y/plates/a.png') throw new Error('ENOENT');
      return new Uint8Array([1]);
    });
    await saveProject('/y/copy.oblique', use(makeDeps({ readFile })));

    expect(readFile).toHaveBeenCalledWith('/y/plates/a.png');
    expect(sources.isSourceMissing('n1')).toBe(true);
    expect(sources.missingReason('n1')).toBe('not-found');
  });

  it('absolute paths are not re-read on Save As', async () => {
    putFile('/x/proj.oblique', sampleScene()); // /pics/a.png
    await loadProject('/x/proj.oblique', use(makeDeps()));
    const readFile = vi.fn(async () => new Uint8Array([1]));
    await saveProject('/y/copy.oblique', use(makeDeps({ readFile })));
    expect(readFile).not.toHaveBeenCalled();
  });

  it('a plain Save to the same file re-checks nothing', async () => {
    putFile('/x/proj.oblique', relativeScene('plates/a.png'));
    await loadProject('/x/proj.oblique', use(makeDeps()));
    const readFile = vi.fn(async () => new Uint8Array([1]));
    await saveProject('/x/proj.oblique', use(makeDeps({ readFile })));
    expect(readFile).not.toHaveBeenCalled();
  });
});
