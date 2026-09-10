import { appDataDir, join } from '@tauri-apps/api/path';
import { mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';

/**
 * AI backend settings (Epic 17 story 1). App-data JSON, not the project
 * file and not a DB — `design/architecture.md` §Storage, locked decision
 * 10 ("no database"; app-data JSON is for trivia like this). Absent file
 * (first run, or a fresh machine) is not an error: it just means defaults
 * ("no endpoint configured"), same posture as recent-files/window-state.
 */
export interface AiSettings {
  version: 1;
  drawThings: { endpoint: string };
}

const SETTINGS_FILENAME = 'ai-settings.json';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  version: 1,
  drawThings: { endpoint: '' },
};

/** Fs edges injected for tests, same pattern as `project/io.ts`'s `ProjectIoDeps`. */
export interface AiSettingsIoDeps {
  appDataDir: () => Promise<string>;
  join: (...parts: string[]) => Promise<string>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
}

export const tauriAiSettingsIoDeps: AiSettingsIoDeps = {
  appDataDir,
  join: (...parts) => join(...parts),
  mkdir: (path, options) => mkdir(path, options),
  readTextFile,
  writeTextFile,
};

interface AiSettingsState {
  settings: AiSettings;
  /** True once `loadAiSettings` has resolved once (success or defaults-on-miss). */
  loaded: boolean;
}

export const useAiSettingsStore = create<AiSettingsState>(() => ({
  settings: DEFAULT_AI_SETTINGS,
  loaded: false,
}));

/** Tolerant parse: anything not shaped like `AiSettings` falls back to defaults field-by-field. */
function parseSettings(text: string): AiSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
  const record = parsed as { drawThings?: { endpoint?: unknown } } | null;
  const endpoint =
    typeof record?.drawThings?.endpoint === 'string' ? record.drawThings.endpoint : '';
  return { version: 1, drawThings: { endpoint } };
}

async function settingsPath(deps: AiSettingsIoDeps): Promise<string> {
  const dir = await deps.appDataDir();
  return deps.join(dir, SETTINGS_FILENAME);
}

/** Loads settings from app-data into the store; defaults (and `loaded: true`) on any failure. */
export async function loadAiSettings(
  deps: AiSettingsIoDeps = tauriAiSettingsIoDeps,
): Promise<void> {
  try {
    const path = await settingsPath(deps);
    const text = await deps.readTextFile(path);
    useAiSettingsStore.setState({ settings: parseSettings(text), loaded: true });
  } catch {
    // First run (no file yet) or an unreadable file — defaults, not an error.
    useAiSettingsStore.setState({ settings: DEFAULT_AI_SETTINGS, loaded: true });
  }
}

/** Writes the store's current settings to app-data, creating the directory if needed. */
export async function saveAiSettings(
  deps: AiSettingsIoDeps = tauriAiSettingsIoDeps,
): Promise<void> {
  const dir = await deps.appDataDir();
  await deps.mkdir(dir, { recursive: true });
  const path = await deps.join(dir, SETTINGS_FILENAME);
  await deps.writeTextFile(path, JSON.stringify(useAiSettingsStore.getState().settings, null, 2));
}

/**
 * Sets the Draw Things endpoint and persists immediately — the settings
 * dialog saves on blur/Enter, there is no separate Save button, so every
 * commit point calls straight through to this.
 */
export async function setDrawThingsEndpoint(
  endpoint: string,
  deps: AiSettingsIoDeps = tauriAiSettingsIoDeps,
): Promise<void> {
  useAiSettingsStore.setState((state) => ({
    settings: { ...state.settings, drawThings: { endpoint } },
  }));
  await saveAiSettings(deps);
}
