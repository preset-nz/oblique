import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneStore } from '@/scene/store';
import { resetCatalogueLoadForTests, useFontCatalogueStore } from './catalogue';
import { listFonts } from './fontsIpc';
import type { FontFace } from './types';

vi.mock('./fontsIpc', () => ({ listFonts: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn() }));

const face = (family: string, postscriptName: string, weight = 400): FontFace => ({
  family,
  style: 'x',
  postscriptName,
  weight,
  italic: false,
  category: 'sans',
  latin: true,
});

const mocked = vi.mocked(listFonts);

beforeEach(() => {
  mocked.mockReset();
  resetCatalogueLoadForTests();
  useFontCatalogueStore.setState({
    status: 'idle',
    faces: [],
    byPostscript: new Map(),
    families: [],
  });
});

describe('font catalogue store', () => {
  it('loads once: a second call while loading or ready is a no-op', async () => {
    mocked.mockResolvedValue([face('A', 'A-Regular')]);
    const { load } = useFontCatalogueStore.getState();
    const first = load();
    const second = load();
    await Promise.all([first, second]);
    await load();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(useFontCatalogueStore.getState().status).toBe('ready');
  });

  it('sets status error with empty faces on failure, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocked.mockRejectedValue(new Error('boom'));
    await useFontCatalogueStore.getState().load();
    const s = useFontCatalogueStore.getState();
    expect(s.status).toBe('error');
    expect(s.faces).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('groups families in Rust order and indexes by PostScript name', async () => {
    const faces = [
      face('Alpha', 'Alpha-Light', 300),
      face('Alpha', 'Alpha-Bold', 700),
      face('Beta', 'Beta-Regular'),
    ];
    mocked.mockResolvedValue(faces);
    await useFontCatalogueStore.getState().load();
    const s = useFontCatalogueStore.getState();
    expect(s.families.map((g) => [g.family, g.faces.length])).toEqual([
      ['Alpha', 2],
      ['Beta', 1],
    ]);
    expect(s.byPostscript.get('Beta-Regular')).toBe(faces[2]);
  });

  it('dirties every text node (both levels) when it becomes ready', async () => {
    const f = { ...face('A', 'A-Regular'), style: 'Regular', italic: false };
    const id = useSceneStore
      .getState()
      .addTextNode({ content: 'hi', font: f, position: { x: 0, y: 0 } });
    const pixelId = 'pixel-1';
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          ...s.scene.nodes.map((n) => ({ ...n, dirty: { draft: false, working: false } })),
          {
            id: pixelId,
            label: 'p',
            type: 'pixel' as const,
            state: 'active' as const,
            output: 'image' as const,
            cameraId: null,
            modifiers: [],
            visible: true,
            blendMode: 'normal' as const,
            opacity: 1,
            dirty: { draft: false, working: false },
            sourcePath: '/p.png',
            sourceSize: [1, 1] as [number, number],
          },
        ],
      },
    }));

    mocked.mockResolvedValue([face('A', 'A-Regular')]);
    await useFontCatalogueStore.getState().load();

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes.find((n) => n.id === id)?.dirty).toEqual({ draft: true, working: true });
    expect(nodes.find((n) => n.id === pixelId)?.dirty).toEqual({ draft: false, working: false });
  });
});
