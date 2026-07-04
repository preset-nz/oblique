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
}));

import { toast } from 'sonner';
import * as cache from '@/scene/cache';
import * as history from '@/scene/history';
import type { ProjectIoDeps } from './io';
import {
  loadProject,
  newProject,
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
    ...overrides,
  };
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
  vi.clearAllMocks();
});

describe('serialise/parse round trip', () => {
  it('load(save(scene)) deep-equals scene', () => {
    const scene = sampleScene();
    expect(parseProject(serialiseProject(scene))).toEqual(scene);
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
});

describe('writeProjectFile', () => {
  it('writes a temp file then renames over the target (atomic)', async () => {
    const deps = makeDeps();
    await writeProjectFile('/proj/x.oblique', sampleScene(), deps);

    const writtenPath = (deps.writeTextFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(writtenPath).toMatch(/^\/proj\/x\.oblique\.tmp-/);
    expect(deps.rename).toHaveBeenCalledWith(writtenPath, '/proj/x.oblique');
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
