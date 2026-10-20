import { invoke } from '@tauri-apps/api/core';
import { SidecarError, useSidecarStatusStore } from '@/sidecar/client';
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

/** The model's id in app-kit's registry (`src-tauri/src/models.rs`). */
export const MOBILE_SAM_ID = 'mobile_sam';

/**
 * MobileSAM isn't on disk: it was removed while Smart Select was armed, or never downloaded.
 * `src/canvas/smartSelect/` turns it into "MobileSAM isn't installed"; choosing the tool again
 * asks (model-downloads.md).
 */
export class ModelMissingError extends Error {
  constructor(readonly modelId: string = MOBILE_SAM_ID) {
    super(`Model ${modelId} isn't installed`);
    this.name = 'ModelMissingError';
  }
}

/** Path/transport edges injected for tests, same pattern as `ai/settings.ts`'s `AiSettingsIoDeps`. */
export interface SidecarSegmentDeps {
  /** The folder app-kit installed the model in (`app_kit_models_path`); rejects when it isn't installed. */
  modelDir: (id: string) => Promise<string>;
  request: (
    header: Record<string, unknown>,
    payload: Uint8Array,
  ) => Promise<{ header: Record<string, unknown>; payload: Uint8Array }>;
}

async function productionRequest(
  header: Record<string, unknown>,
  payload: Uint8Array,
): Promise<{ header: Record<string, unknown>; payload: Uint8Array }> {
  // Dynamic import: the singleton starts the real Tauri transport as a side
  // effect of being imported (see sidecar/singleton.ts) — deferred to
  // call-time so importing this module (with injected deps, as every test
  // does) never pulls in Tauri IPC. Mirrors cook.ts's `realRunPython`.
  const { sidecarClient } = await import('@/sidecar/singleton');
  return sidecarClient.request(header, payload);
}

export const productionSidecarSegmentDeps: SidecarSegmentDeps = {
  modelDir: (id) => invoke<string>('app_kit_models_path', { id }),
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

/** app-kit's `NotInstalled`, as it arrives over `invoke` (a plain string). */
function isNotInstalled(err: unknown): boolean {
  return /isn't installed/.test(err instanceof Error ? err.message : String(err));
}

/**
 * `segment` over the sidecar frame protocol (segment-to-vector.md's fixed
 * request/response header shape). `model_dir` is the model's folder in
 * app-kit's models folder, asked of Rust here so the sidecar stays free of
 * platform-path logic. Nothing downloads: a model that isn't there is a
 * `ModelMissingError`, whether Rust says so or the sidecar's `model_missing`
 * answer does (model-downloads.md).
 */
export async function segment(
  options: SegmentOptions,
  deps: SidecarSegmentDeps = productionSidecarSegmentDeps,
): Promise<SegmentResult> {
  let modelDir: string;
  try {
    modelDir = await deps.modelDir(MOBILE_SAM_ID);
  } catch (err) {
    if (isNotInstalled(err)) throw new ModelMissingError();
    throw err;
  }

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

  let response: { header: Record<string, unknown>; payload: Uint8Array };
  try {
    response = await deps.request(header, packSegmentPayload(options.image, options.mask));
  } catch (err) {
    if (err instanceof SidecarError && err.code === 'model_missing') throw new ModelMissingError();
    throw err;
  }
  const { header: responseHeader, payload } = response;

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
