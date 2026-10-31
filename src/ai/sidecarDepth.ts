import { SidecarError } from '@/sidecar/client';
import { isNotInstalled, ModelMissingError, productionSidecarSegmentDeps } from './sidecarSegment';

/**
 * `depth` over the sidecar frame protocol (Epic 17 story 5, `depth-map.md`): Depth Anything V2
 * Small, one request and one answer, shaped like `sidecarSegment.ts`. The sidecar returns the
 * finished PNG (grey and the source's alpha, 8 or 16 bit); the client writes those bytes as
 * they are, so no canvas touches the grey levels.
 *
 * Nothing downloads here. The model is app-kit's, asked for by `createDepthMap` before the
 * request (`useModelGate`), and one that has gone since is a `ModelMissingError`.
 */

/** The model's id in app-kit's registry (`src-tauri/src/models.rs`). */
export const DEPTH_MODEL_ID = 'depth_anything_v2_small';

/** CPU inference on a large raster can honestly outlast the client's 30 s default. */
export const DEPTH_TIMEOUT_MS = 180_000;

export type DepthBits = 8 | 16;

export interface DepthOptions {
  /** RGBA8 bytes, `width * height * 4`. */
  image: Uint8Array;
  width: number;
  height: number;
  /** Grey level depth of the PNG the sidecar writes. Default 8. */
  bits?: DepthBits;
}

export interface DepthResult {
  /** The finished PNG: grey and the source's alpha, near white. */
  png: Uint8Array;
  width: number;
  height: number;
  bits: DepthBits;
}

/** Path/transport edges injected for tests, same pattern as `SidecarSegmentDeps`. */
export interface SidecarDepthDeps {
  /** The folder app-kit installed the model in (`app_kit_models_path`); rejects when it isn't installed. */
  modelDir: (id: string) => Promise<string>;
  request: (
    header: Record<string, unknown>,
    payload: Uint8Array,
    timeoutMs: number,
  ) => Promise<{ header: Record<string, unknown>; payload: Uint8Array }>;
}

export const productionSidecarDepthDeps: SidecarDepthDeps = {
  // The one `invoke` of `app_kit_models_path` stays in `sidecarSegment.ts` (depcruise).
  modelDir: productionSidecarSegmentDeps.modelDir,
  request: async (header, payload, timeoutMs) => {
    // Dynamic import: the singleton starts the real Tauri transport as a side effect of being
    // imported, so a module that is only imported (every test does) never pulls it in.
    const { sidecarClient } = await import('@/sidecar/singleton');
    return sidecarClient.request(header, payload, timeoutMs);
  },
};

export async function depth(
  options: DepthOptions,
  deps: SidecarDepthDeps = productionSidecarDepthDeps,
): Promise<DepthResult> {
  const bits: DepthBits = options.bits ?? 8;

  let modelDir: string;
  try {
    modelDir = await deps.modelDir(DEPTH_MODEL_ID);
  } catch (err) {
    if (isNotInstalled(err)) throw new ModelMissingError(DEPTH_MODEL_ID);
    throw err;
  }

  const header = {
    op: 'depth',
    width: options.width,
    height: options.height,
    model_dir: modelDir,
    bits,
  };

  try {
    const { payload } = await deps.request(header, options.image, DEPTH_TIMEOUT_MS);
    return { png: payload, width: options.width, height: options.height, bits };
  } catch (err) {
    if (err instanceof SidecarError && err.code === 'model_missing') {
      throw new ModelMissingError(DEPTH_MODEL_ID);
    }
    throw err;
  }
}
