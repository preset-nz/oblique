import { describe, expect, it, vi } from 'vitest';
import { SidecarError } from '@/sidecar/client';
import { DEPTH_MODEL_ID, DEPTH_TIMEOUT_MS, depth, type SidecarDepthDeps } from './sidecarDepth';
import { ModelMissingError } from './sidecarSegment';

function makeDeps(overrides: Partial<SidecarDepthDeps> = {}) {
  const request = vi.fn(async (_h: Record<string, unknown>, _p: Uint8Array, _t: number) => ({
    header: { ok: true },
    payload: new Uint8Array([137, 80, 78, 71]),
  }));
  const deps: SidecarDepthDeps = {
    modelDir: vi.fn(async (id: string) => `/models-root/${id}`),
    request,
    ...overrides,
  };
  return { deps, request };
}

describe('depth (depth-map.md)', () => {
  it('sends op depth with model_dir for the depth model, the raster as the payload, and a long timeout', async () => {
    const { deps, request } = makeDeps();
    const image = new Uint8Array(2 * 1 * 4);

    const result = await depth({ image, width: 2, height: 1 }, deps);

    expect(deps.modelDir).toHaveBeenCalledWith('depth_anything_v2_small');
    expect(DEPTH_MODEL_ID).toBe('depth_anything_v2_small');
    const [header, payload, timeout] = request.mock.calls[0];
    expect(header).toEqual({
      op: 'depth',
      width: 2,
      height: 1,
      model_dir: '/models-root/depth_anything_v2_small',
      bits: 8,
    });
    expect(payload).toBe(image);
    expect(timeout).toBe(DEPTH_TIMEOUT_MS);
    expect(result).toEqual({
      png: new Uint8Array([137, 80, 78, 71]),
      width: 2,
      height: 1,
      bits: 8,
    });
  });

  it('asks for 16 bits when told to', async () => {
    const { deps, request } = makeDeps();
    const result = await depth({ image: new Uint8Array(4), width: 1, height: 1, bits: 16 }, deps);
    expect(request.mock.calls[0][0]).toMatchObject({ bits: 16 });
    expect(result.bits).toBe(16);
  });

  it("is a ModelMissingError when app-kit says the model isn't installed, with no request", async () => {
    const { deps, request } = makeDeps({
      modelDir: vi.fn(async () => {
        throw "Model depth_anything_v2_small isn't installed";
      }),
    });
    await expect(depth({ image: new Uint8Array(4), width: 1, height: 1 }, deps)).rejects.toThrow(
      ModelMissingError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("is a ModelMissingError when the sidecar's answer is model_missing", async () => {
    const { deps } = makeDeps({
      request: vi.fn(async () => {
        throw new SidecarError('model not installed: depth_anything_v2_small', 'model_missing');
      }),
    });
    const error = await depth({ image: new Uint8Array(4), width: 1, height: 1 }, deps).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ModelMissingError);
    expect((error as ModelMissingError).modelId).toBe('depth_anything_v2_small');
  });

  it('lets any other failure through', async () => {
    const boom = new Error('onnx exploded');
    const { deps } = makeDeps({ request: vi.fn(async () => Promise.reject(boom)) });
    await expect(depth({ image: new Uint8Array(4), width: 1, height: 1 }, deps)).rejects.toBe(boom);
  });
});
