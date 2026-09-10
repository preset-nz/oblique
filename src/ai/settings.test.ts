import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AiSettingsIoDeps,
  DEFAULT_AI_SETTINGS,
  loadAiSettings,
  setDrawThingsEndpoint,
  useAiSettingsStore,
} from './settings';

/** In-memory fs stand-in — same injected-deps pattern as `project/io.test.ts`. */
function fakeDeps(): AiSettingsIoDeps & { files: Map<string, string> } {
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

describe('AI settings — round trip', () => {
  beforeEach(() => {
    useAiSettingsStore.setState({ settings: DEFAULT_AI_SETTINGS, loaded: false });
  });

  it('absent file loads as defaults (no endpoint)', async () => {
    const deps = fakeDeps();

    await loadAiSettings(deps);

    expect(useAiSettingsStore.getState().settings).toEqual(DEFAULT_AI_SETTINGS);
    expect(useAiSettingsStore.getState().loaded).toBe(true);
  });

  it('an endpoint set and saved survives a simulated restart (fresh store + reload)', async () => {
    const deps = fakeDeps();

    await setDrawThingsEndpoint('http://127.0.0.1:7860', deps);
    expect(useAiSettingsStore.getState().settings.drawThings.endpoint).toBe(
      'http://127.0.0.1:7860',
    );

    // Simulate a restart: reset the store, then reload from the same
    // (persisted) fs backing.
    useAiSettingsStore.setState({ settings: DEFAULT_AI_SETTINGS, loaded: false });
    await loadAiSettings(deps);

    expect(useAiSettingsStore.getState().settings.drawThings.endpoint).toBe(
      'http://127.0.0.1:7860',
    );
  });

  it('writes to <appDataDir>/ai-settings.json', async () => {
    const deps = fakeDeps();

    await setDrawThingsEndpoint('http://localhost:1234', deps);

    const written = deps.files.get('/app-data/ai-settings.json');
    expect(written).toBeDefined();
    expect(JSON.parse(written ?? '')).toEqual({
      version: 1,
      drawThings: { endpoint: 'http://localhost:1234' },
    });
  });

  it('a corrupt file falls back to defaults rather than throwing', async () => {
    const deps = fakeDeps();
    deps.files.set('/app-data/ai-settings.json', 'not json');

    await loadAiSettings(deps);

    expect(useAiSettingsStore.getState().settings).toEqual(DEFAULT_AI_SETTINGS);
  });
});
