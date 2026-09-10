import type { AiAdapter, AiTask, HealthResult } from './adapter';
import { useAiSettingsStore } from './settings';

/** `fetch` injected for tests; production uses the global. */
export interface DrawThingsDeps {
  fetch: typeof fetch;
}

export const defaultDrawThingsDeps: DrawThingsDeps = { fetch: (...args) => fetch(...args) };

const HEALTH_TIMEOUT_MS = 5_000;

// Draw Things (drawthings.ai) exposes an HTTP API when "HTTP Server" is
// enabled in-app; it has no documented dedicated health/status route, so
// the smallest honest probe is a GET of the endpoint root — any HTTP
// response (2xx or not) proves the server is listening, and only a
// connection failure (closed port, wrong host) is a network error.
const HEALTH_PATH = '';

/**
 * Draw Things driver (Epic 17 story 1 — health only; `inpaint` lands in
 * story 3 / generative-fill.md). `getEndpoint` is injected so the driver
 * doesn't need to know the settings store shape beyond one string, and so
 * tests can drive it without the store at all.
 */
export function createDrawThingsDriver(
  getEndpoint: () => string,
  deps: DrawThingsDeps = defaultDrawThingsDeps,
): AiAdapter {
  const capabilities: ReadonlySet<AiTask> = new Set();

  return {
    capabilities,
    async health(): Promise<HealthResult> {
      const endpoint = getEndpoint().trim();
      if (!endpoint) return { ok: false, detail: 'No endpoint configured' };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      try {
        const res = await deps.fetch(`${endpoint.replace(/\/+$/, '')}${HEALTH_PATH}`, {
          method: 'GET',
          signal: controller.signal,
        });
        if (res.ok) return { ok: true, detail: 'Connected' };
        return { ok: false, detail: `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** App-wide instance, wired to the persisted settings store. */
export const drawThingsDriver: AiAdapter = createDrawThingsDriver(
  () => useAiSettingsStore.getState().settings.drawThings.endpoint,
);
