import { appDataDir, join } from '@tauri-apps/api/path';
import { useSidecarStatusStore } from '@/sidecar/client';
import type { AiAdapter, AiTask, HealthResult, SegmentOptions, SegmentResult } from './adapter';

/**
 * Sidecar-hosted segmentation driver (Epic 17 story 2 —
 * `guidance/projects/oblique/features/17-ml-masking-and-fill/
 * segment-to-vector.md`). MobileSAM via onnxruntime, IN the sidecar, not
 * over HTTP (epic decision) — this module only speaks the frame protocol
 * (`src/sidecar/client.ts`), the same request/response shape `cook.ts` uses
 * for `cook`, with `op: 'segment'` instead.
 *
 * `health` reuses the connection status the app already tracks
 * (`src/sidecar/client.ts`) rather than issuing a second probe.
 */
const capabilities: ReadonlySet<AiTask> = new Set<AiTask>(['segment']);

/**
 * The first `segment` request may download ~40 MB of weights synchronously
 * inside the sidecar (no progress frames — segment-to-vector.md's fixed
 * contract) before it can answer at all. The frame client's default 30s
 * timeout is sized for ordinary cooks, not a cold weights fetch, so this
 * request gets a much longer one; `src/canvas/smartSelect/` is what turns
 * "still pending after ~1s" into the visible downloading state, this is
 * just the ceiling that keeps a slow-but-real download from being killed.
 */
const SEGMENT_TIMEOUT_MS = 180_000;

const MODELS_DIR_NAME = 'models';

/** Path/transport edges injected for tests, same pattern as `ai/settings.ts`'s `AiSettingsIoDeps`. */
export interface SidecarSegmentDeps {
  appDataDir: () => Promise<string>;
  join: (...parts: string[]) => Promise<string>;
  request: (
    header: Record<string, unknown>,
    payload: Uint8Array,
    timeoutMs: number,
  ) => Promise<{ header: Record<string, unknown>; payload: Uint8Array }>;
}

async function productionRequest(
  header: Record<string, unknown>,
  payload: Uint8Array,
  timeoutMs: number,
): Promise<{ header: Record<string, unknown>; payload: Uint8Array }> {
  // Dynamic import: the singleton starts the real Tauri transport as a side
  // effect of being imported (see sidecar/singleton.ts) — deferred to
  // call-time so importing this module (with injected deps, as every test
  // does) never pulls in Tauri IPC. Mirrors cook.ts's `realRunPython`.
  const { sidecarClient } = await import('@/sidecar/singleton');
  return sidecarClient.request(header, payload, timeoutMs);
}

export const productionSidecarSegmentDeps: SidecarSegmentDeps = {
  appDataDir,
  join: (...parts) => join(...parts),
  request: productionRequest,
};

/** Concatenate the image payload with the optional 256x256 coarse mask — one payload, `payload_bytes` covers both (segment-to-vector.md's fixed contract). */
function packSegmentPayload(image: Uint8Array, mask: Uint8Array | undefined): Uint8Array {
  if (!mask) return image;
  const out = new Uint8Array(image.byteLength + mask.byteLength);
  out.set(image, 0);
  out.set(mask, image.byteLength);
  return out;
}

function isPointArray(value: unknown): value is Array<{ x: number; y: number }> {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        p !== null &&
        typeof p === 'object' &&
        typeof (p as { x?: unknown }).x === 'number' &&
        typeof (p as { y?: unknown }).y === 'number',
    )
  );
}

/** `header.polygons` -> `SegmentResult['polygons']`, tolerant of a missing/malformed field (treated as "no polygons found", not a crash). */
function parsePolygons(value: unknown): Array<Array<{ x: number; y: number }>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isPointArray);
}

/**
 * `segment` over the sidecar frame protocol (segment-to-vector.md's fixed
 * request/response header shape). `model_dir` is resolved here (app-data +
 * `models`) so the sidecar itself stays free of platform-path logic — the
 * epic's own framing for `fetch.py`'s `ensure_weights`.
 */
export async function segment(
  options: SegmentOptions,
  deps: SidecarSegmentDeps = productionSidecarSegmentDeps,
): Promise<SegmentResult> {
  const dir = await deps.appDataDir();
  const modelDir = await deps.join(dir, MODELS_DIR_NAME);

  const header = {
    op: 'segment',
    width: options.width,
    height: options.height,
    model_dir: modelDir,
    prompt: {
      points: options.points ?? [],
      box: options.box ?? null,
      mask: Boolean(options.mask),
    },
  };

  const { header: responseHeader, payload } = await deps.request(
    header,
    packSegmentPayload(options.image, options.mask),
    SEGMENT_TIMEOUT_MS,
  );

  return {
    mask: payload,
    polygons: parsePolygons(responseHeader.polygons),
  };
}

export const sidecarSegmentDriver: AiAdapter = {
  capabilities,
  async health(): Promise<HealthResult> {
    const { status, lastError } = useSidecarStatusStore.getState();
    if (status === 'up') return { ok: true, detail: 'Connected' };
    return { ok: false, detail: lastError ?? 'Sidecar not running' };
  },
  segment: (options) => segment(options),
};
