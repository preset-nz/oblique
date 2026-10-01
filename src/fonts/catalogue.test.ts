import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFontCatalogueStore } from './catalogue';
import { listFonts } from './fontsIpc';
import type { FontFace } from './types';

vi.mock('./fontsIpc', () => ({ listFonts: vi.fn() }));

const face = (family: string, postscriptName: string, weight = 400): FontFace => ({
  family,
  style: 'x',
  postscriptName,
  weight,
  italic: false,
  category: 'sans',
});

const mocked = vi.mocked(listFonts);

beforeEach(() => {
  mocked.mockReset();
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
});
