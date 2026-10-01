import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_FONT_PREFERENCES,
  type FontPreferencesIoDeps,
  loadFontPreferences,
  noteUsed,
  noteUsedIn,
  parseFontPreferences,
  RECENT_LIMIT,
  toggleFavourite,
  toggleFavouriteIn,
  useFontPreferencesStore,
} from './preferences';

function fakeDeps(): FontPreferencesIoDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    appDataDir: async () => '/app-data',
    join: async (...parts) => parts.join('/'),
    mkdir: async () => {},
    readTextFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    writeTextFile: async (path, contents) => {
      files.set(path, contents);
    },
  };
}

const PATH = '/app-data/font-preferences.json';

beforeEach(() => {
  useFontPreferencesStore.setState({ prefs: EMPTY_FONT_PREFERENCES, loaded: false });
});

describe('noteUsedIn', () => {
  it('puts the most recent first and de-duplicates', () => {
    let p = EMPTY_FONT_PREFERENCES;
    for (const f of ['A', 'B', 'C', 'A']) p = noteUsedIn(p, f);
    expect(p.recent).toEqual(['A', 'C', 'B']);
  });

  it('caps at 8, dropping the oldest', () => {
    let p = EMPTY_FONT_PREFERENCES;
    for (let i = 1; i <= 10; i++) p = noteUsedIn(p, `F${i}`);
    expect(p.recent).toHaveLength(RECENT_LIMIT);
    expect(p.recent[0]).toBe('F10');
    expect(p.recent[7]).toBe('F3');
  });
});

describe('toggleFavouriteIn', () => {
  it('round-trips', () => {
    const on = toggleFavouriteIn(EMPTY_FONT_PREFERENCES, 'Futura');
    expect(on.favourites).toEqual(['Futura']);
    expect(toggleFavouriteIn(on, 'Futura').favourites).toEqual([]);
  });
});

describe('parseFontPreferences', () => {
  it('falls back to empty lists for malformed input', () => {
    for (const text of ['not json', 'null', '42', '[]', '{"favourites":"x","recent":{"a":1}}']) {
      expect(parseFontPreferences(text)).toEqual(EMPTY_FONT_PREFERENCES);
    }
  });

  it('keeps well-formed strings, drops the rest, caps recent', () => {
    const recent = Array.from({ length: 12 }, (_, i) => `R${i}`);
    const p = parseFontPreferences(
      JSON.stringify({ version: 1, favourites: ['A', 3, 'A', '', 'B'], recent }),
    );
    expect(p.favourites).toEqual(['A', 'B']);
    expect(p.recent).toEqual(recent.slice(0, RECENT_LIMIT));
  });
});

describe('persistence', () => {
  it('absent file loads as empty lists', async () => {
    await loadFontPreferences(fakeDeps());
    expect(useFontPreferencesStore.getState().prefs).toEqual(EMPTY_FONT_PREFERENCES);
    expect(useFontPreferencesStore.getState().loaded).toBe(true);
  });

  it('writes font-preferences.json and survives a simulated restart', async () => {
    const deps = fakeDeps();
    await toggleFavourite('Futura', deps);
    await noteUsed('Futura', deps);
    await noteUsed('Didot', deps);
    expect(JSON.parse(deps.files.get(PATH) ?? '')).toEqual({
      version: 1,
      favourites: ['Futura'],
      recent: ['Didot', 'Futura'],
    });

    useFontPreferencesStore.setState({ prefs: EMPTY_FONT_PREFERENCES, loaded: false });
    await loadFontPreferences(deps);
    expect(useFontPreferencesStore.getState().prefs.favourites).toEqual(['Futura']);
    expect(useFontPreferencesStore.getState().prefs.recent).toEqual(['Didot', 'Futura']);
  });

  it('a corrupt file loads as empty lists', async () => {
    const deps = fakeDeps();
    deps.files.set(PATH, '{{{');
    await loadFontPreferences(deps);
    expect(useFontPreferencesStore.getState().prefs).toEqual(EMPTY_FONT_PREFERENCES);
  });

  it('a failed write is logged, not thrown, and the in-memory change stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = fakeDeps();
    deps.writeTextFile = async () => {
      throw new Error('disk full');
    };
    await expect(toggleFavourite('Futura', deps)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(useFontPreferencesStore.getState().prefs.favourites).toEqual(['Futura']);
    warn.mockRestore();
  });
});
