import { appDataDir, join } from '@tauri-apps/api/path';
import { mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';

/**
 * Family-picker favourites and recents (font-picker-curation.md). App-data JSON,
 * the same posture and IO-deps pattern as `ai/settings.ts`: an absent or damaged
 * file is not an error, it just means empty lists.
 */
export interface FontPreferences {
  version: 1;
  /** Family names. */
  favourites: string[];
  /** Family names, most recent first. */
  recent: string[];
}

export const RECENT_LIMIT = 8;
const PREFERENCES_FILENAME = 'font-preferences.json';

export const EMPTY_FONT_PREFERENCES: FontPreferences = { version: 1, favourites: [], recent: [] };

/** Fs edges injected for tests, same shape as `AiSettingsIoDeps`. */
export interface FontPreferencesIoDeps {
  appDataDir: () => Promise<string>;
  join: (...parts: string[]) => Promise<string>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
}

export const tauriFontPreferencesIoDeps: FontPreferencesIoDeps = {
  appDataDir,
  join: (...parts) => join(...parts),
  mkdir: (path, options) => mkdir(path, options),
  readTextFile,
  writeTextFile,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const stringList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0 && !out.includes(item)) out.push(item);
  }
  return out;
};

/** Tolerant parse: anything not shaped like `FontPreferences` falls back to empty lists, field by field. */
export function parseFontPreferences(text: string): FontPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_FONT_PREFERENCES;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_FONT_PREFERENCES;
  const record = parsed as { favourites?: unknown; recent?: unknown };
  return {
    version: 1,
    favourites: stringList(record.favourites),
    recent: stringList(record.recent).slice(0, RECENT_LIMIT),
  };
}

export function toggleFavouriteIn(prefs: FontPreferences, family: string): FontPreferences {
  const favourites = prefs.favourites.includes(family)
    ? prefs.favourites.filter((f) => f !== family)
    : [...prefs.favourites, family];
  return { ...prefs, favourites };
}

/** Most recent first, de-duplicated, capped at `RECENT_LIMIT`. */
export function noteUsedIn(prefs: FontPreferences, family: string): FontPreferences {
  const recent = [family, ...prefs.recent.filter((f) => f !== family)].slice(0, RECENT_LIMIT);
  return { ...prefs, recent };
}

// ---------------------------------------------------------------------------
// Store + persistence
// ---------------------------------------------------------------------------

interface FontPreferencesState {
  prefs: FontPreferences;
  loaded: boolean;
}

export const useFontPreferencesStore = create<FontPreferencesState>(() => ({
  prefs: EMPTY_FONT_PREFERENCES,
  loaded: false,
}));

/** "Favourites only" in the picker. Per session: never persisted. */
export const useFavouritesOnlyStore = create<{
  on: boolean;
  setOn: (on: boolean) => void;
}>((set) => ({ on: false, setOn: (on) => set({ on }) }));

/** Loads the preferences into the store; empty lists (and `loaded: true`) on any failure. */
export async function loadFontPreferences(
  deps: FontPreferencesIoDeps = tauriFontPreferencesIoDeps,
): Promise<void> {
  try {
    const dir = await deps.appDataDir();
    const text = await deps.readTextFile(await deps.join(dir, PREFERENCES_FILENAME));
    useFontPreferencesStore.setState({ prefs: parseFontPreferences(text), loaded: true });
  } catch {
    // First run (no file yet) or an unreadable file.
    useFontPreferencesStore.setState({ prefs: EMPTY_FONT_PREFERENCES, loaded: true });
  }
}

async function savePreferences(deps: FontPreferencesIoDeps): Promise<void> {
  const dir = await deps.appDataDir();
  await deps.mkdir(dir, { recursive: true });
  const path = await deps.join(dir, PREFERENCES_FILENAME);
  await deps.writeTextFile(path, JSON.stringify(useFontPreferencesStore.getState().prefs, null, 2));
}

// Writes queue behind each other so the last change is the last write on disk.
let writeChain: Promise<void> = Promise.resolve();

/** Fire-and-forget persistence: failures are logged, never thrown, never toasted. The promise is for tests. */
function persist(deps: FontPreferencesIoDeps): Promise<void> {
  writeChain = writeChain.then(() =>
    savePreferences(deps).catch((err) => {
      console.warn('Could not save font preferences:', err);
    }),
  );
  return writeChain;
}

export function toggleFavourite(
  family: string,
  deps: FontPreferencesIoDeps = tauriFontPreferencesIoDeps,
): Promise<void> {
  useFontPreferencesStore.setState((s) => ({ prefs: toggleFavouriteIn(s.prefs, family) }));
  return persist(deps);
}

export function noteUsed(
  family: string,
  deps: FontPreferencesIoDeps = tauriFontPreferencesIoDeps,
): Promise<void> {
  useFontPreferencesStore.setState((s) => ({ prefs: noteUsedIn(s.prefs, family) }));
  return persist(deps);
}
