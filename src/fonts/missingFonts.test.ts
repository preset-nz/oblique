import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./fontsIpc', () => ({ listFonts: vi.fn(), textOutlines: vi.fn() }));
vi.mock('@preset.nz/ux-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@preset.nz/ux-kit')>()),
  notify: vi.fn(),
  dismissNotification: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn(), confirm: vi.fn() }));
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

import { Mirror, rowsFromScene } from '@/rhizome/adapter';
import { useSceneStore } from '@/scene/store';
import { specFor } from '@/scene/textGeometryCache';
import { isTextNode, type Scene, type TextNode } from '@/scene/types';
import { useFontCatalogueStore } from './catalogue';
import {
  findMissingFonts,
  findUsedFonts,
  missingFontTooltip,
  useMissingFontsStore,
} from './missingFonts';
import { BLACKLETTER_BOLD, face, INSTALLED } from './testFixtures';
import type { FontFace, FontRef } from './types';

const font = (family: string, style: string, ps: string, weight = 400): FontRef => ({
  family,
  style,
  postscriptName: ps,
  weight,
  italic: false,
  category: 'serif',
});

function setCatalogue(status: 'idle' | 'loading' | 'ready' | 'error', faces: FontFace[]) {
  useFontCatalogueStore.setState({
    status,
    faces,
    byPostscript: new Map(faces.map((f) => [f.postscriptName, f])),
    families: [],
  });
}

function emptyScene(): Scene {
  return {
    id: 's',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [800, 400],
  };
}

const addText = (f: FontRef): string =>
  useSceneStore.getState().addTextNode({ content: 'hi', font: f, position: { x: 0, y: 0 } });

const textNodes = (): TextNode[] => useSceneStore.getState().scene.nodes.filter(isTextNode);

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  setCatalogue('idle', []);
  useMissingFontsStore.setState({
    missing: [],
    warnPending: false,
    warningOpen: false,
    signature: '',
  });
});

describe('findMissingFonts', () => {
  it('groups by wanted PostScript name, sorted by family then style, with the matcher substitute', () => {
    addText(BLACKLETTER_BOLD);
    addText(font('Zeta Face', 'Regular', 'Zeta-Regular'));
    addText(BLACKLETTER_BOLD);
    addText(font('Blackletter Grim', 'Black', 'BlackletterGrim-Black', 900));
    addText(INSTALLED[0]); // installed: not reported
    addText(BLACKLETTER_BOLD);

    const missing = findMissingFonts(textNodes(), INSTALLED);
    expect(missing.map((m) => `${m.wanted.family} ${m.wanted.style}`)).toEqual([
      'Blackletter Grim Black',
      'Blackletter Grim Bold',
      'Zeta Face Regular',
    ]);
    const bold = missing[1];
    expect(bold.nodeIds).toHaveLength(3);
    expect(bold.substitute?.postscriptName).toBe('TimesNewRomanPS-BoldMT');
    expect(missing.every((m) => m.missing)).toBe(true);
  });

  it('reports a null substitute when nothing is installed, and finds nothing when all is installed', () => {
    addText(BLACKLETTER_BOLD);
    expect(findMissingFonts(textNodes(), [])[0].substitute).toBeNull();
    expect(findMissingFonts(textNodes(), [{ ...BLACKLETTER_BOLD, latin: true }])).toEqual([]);
  });

  it('findUsedFonts lists installed fonts too, flagged', () => {
    addText(BLACKLETTER_BOLD);
    addText(INSTALLED[0]);
    const used = findUsedFonts(textNodes(), INSTALLED);
    expect(used.map((u) => [u.wanted.family, u.missing])).toEqual([
      ['Blackletter Grim', true],
      ['Helvetica Neue', false],
    ]);
  });
});

describe('missingFontTooltip', () => {
  it('names the wanted font and the substitute', () => {
    expect(missingFontTooltip(BLACKLETTER_BOLD, INSTALLED[3])).toBe(
      'Font missing: Blackletter Grim Bold — showing Times New Roman Bold',
    );
  });
});

describe('saving after a substitution', () => {
  it('writes the WANTED font back unchanged', () => {
    setCatalogue('ready', INSTALLED);
    const id = addText({ ...BLACKLETTER_BOLD });
    const node = textNodes().find((n) => n.id === id) as TextNode;
    // Rendering uses the stand-in...
    expect(specFor(node).postscriptName).toBe('TimesNewRomanPS-BoldMT');
    // ...but the file names the wanted font.
    // (the document is held as rhizome rows; this is what Open reads back)
    const mirror = new Mirror();
    mirror.load({
      seq: 0,
      generation: 0,
      schema: null,
      rows: [...rowsFromScene(useSceneStore.getState().scene).values()],
    });
    const reloaded = mirror.scene()?.nodes.find((n) => n.id === id) as TextNode;
    expect(reloaded.font).toEqual(BLACKLETTER_BOLD);
  });
});

describe('useMissingFontsStore', () => {
  it('recomputes when the catalogue becomes ready or the wanted fonts change', () => {
    addText(BLACKLETTER_BOLD);
    expect(useMissingFontsStore.getState().missing).toEqual([]); // catalogue not ready
    setCatalogue('ready', INSTALLED);
    expect(useMissingFontsStore.getState().missing).toHaveLength(1);
    addText(font('Another', 'Regular', 'Another-Regular'));
    expect(useMissingFontsStore.getState().missing).toHaveLength(2);
  });

  it('warns on open when the catalogue is ready, and not when nothing is missing', () => {
    setCatalogue('ready', INSTALLED);
    addText(INSTALLED[0]);
    useMissingFontsStore.getState().documentOpened();
    expect(useMissingFontsStore.getState().warningOpen).toBe(false);

    addText(BLACKLETTER_BOLD);
    useMissingFontsStore.getState().documentOpened();
    expect(useMissingFontsStore.getState().warningOpen).toBe(true);
  });

  it('waits for the catalogue, then warns exactly once per open', () => {
    addText(BLACKLETTER_BOLD);
    setCatalogue('loading', []);
    useMissingFontsStore.getState().documentOpened();
    expect(useMissingFontsStore.getState().warningOpen).toBe(false);
    expect(useMissingFontsStore.getState().warnPending).toBe(true);

    setCatalogue('ready', INSTALLED);
    expect(useMissingFontsStore.getState().warningOpen).toBe(true);
    expect(useMissingFontsStore.getState().warnPending).toBe(false);

    // OK closes it; a later catalogue change does not bring it back.
    useMissingFontsStore.getState().setWarningOpen(false);
    setCatalogue('ready', [...INSTALLED, face('Extra', 'Regular', 'Extra-Regular')]);
    expect(useMissingFontsStore.getState().warningOpen).toBe(false);
  });

  it('drops a pending warning when the catalogue fails to load', () => {
    addText(BLACKLETTER_BOLD);
    setCatalogue('loading', []);
    useMissingFontsStore.getState().documentOpened();
    setCatalogue('error', []);
    expect(useMissingFontsStore.getState().warnPending).toBe(false);
    expect(useMissingFontsStore.getState().warningOpen).toBe(false);
  });
});
