import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidecarError, useSidecarStatusStore } from '@/sidecar/client';
import { canInpaint, canSegment } from './adapter';
import {
  ModelMissingError,
  type SidecarSegmentDeps,
  segment,
  sidecarSegmentDriver,
} from './sidecarSegment';

describe('sidecar segment driver stub', () => {
  beforeEach(() => {
    useSidecarStatusStore.setState({ status: 'down', lastError: undefined });
  });

  it('declares only the segment capability', () => {
    expect(canSegment(sidecarSegmentDriver)).toBe(true);
    expect(canInpaint(sidecarSegmentDriver)).toBe(false);
  });

  it('health reflects the sidecar being up', async () => {
    useSidecarStatusStore.setState({ status: 'up', lastError: undefined });
    expect(await sidecarSegmentDriver.health()).toEqual({ ok: true, detail: 'Connected' });
  });

  it('health reflects the sidecar being down, with its last error', async () => {
    useSidecarStatusStore.setState({ status: 'down', lastError: 'sidecar exited: signal 9' });
    expect(await sidecarSegmentDriver.health()).toEqual({
      ok: false,
      detail: 'sidecar exited: signal 9',
    });
  });

  it('health reflects the sidecar being down with no recorded error', async () => {
    useSidecarStatusStore.setState({ status: 'down', lastError: undefined });
    expect(await sidecarSegmentDriver.health()).toEqual({
      ok: false,
      detail: 'Sidecar not running',
    });
  });
});

function makeDeps(
  overrides: Partial<SidecarSegmentDeps> = {},
): SidecarSegmentDeps & { requestMock: ReturnType<typeof vi.fn> } {
  const requestMock = vi.fn(async (_header: Record<string, unknown>, _payload: Uint8Array) => ({
    header: {
      ok: true,
      polygons: [
        [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
      ],
    },
    payload: new Uint8Array([9, 9, 9]),
  }));
  return {
    modelDir: vi.fn(async (id: string) => `/models-root/${id}`),
    request: requestMock,
    requestMock,
    ...overrides,
  };
}

describe('segment (segment-to-vector.md)', () => {
  it('sends the fixed request header, model_dir from app-kit for mobile_sam', async () => {
    const deps = makeDeps();
    const image = new Uint8Array([1, 2, 3, 4]);

    await segment({ image, width: 2, height: 1, points: [{ x: 1, y: 1, label: 1 }] }, deps);

    expect(deps.modelDir).toHaveBeenCalledWith('mobile_sam');
    expect(deps.requestMock).toHaveBeenCalledTimes(1);
    const [header, payload, ...rest] = deps.requestMock.mock.calls[0];
    expect(header).toMatchObject({
      op: 'segment',
      width: 2,
      height: 1,
      model_dir: '/models-root/mobile_sam',
      prompt: { points: [{ x: 1, y: 1, label: 1 }], box: null, mask: false },
    });
    expect(payload).toBe(image); // no coarse mask -> payload is the image bytes, untouched
    expect(rest).toEqual([]); // the client's default timeout: nothing downloads inside the request
  });

  it('appends the optional 256x256 coarse mask after the image, sets prompt.mask: true', async () => {
    const deps = makeDeps();
    const image = new Uint8Array([1, 2, 3, 4]);
    const mask = new Uint8Array(256 * 256).fill(7);

    await segment({ image, width: 1, height: 1, mask }, deps);

    const [header, payload] = deps.requestMock.mock.calls[0];
    expect((header as { prompt: { mask: boolean } }).prompt.mask).toBe(true);
    expect(payload).toHaveLength(image.byteLength + mask.byteLength);
    expect(payload.slice(0, image.byteLength)).toEqual(image);
    expect(payload.slice(image.byteLength)).toEqual(mask);
  });

  it('defaults an absent box/points to null/empty', async () => {
    const deps = makeDeps();
    await segment({ image: new Uint8Array([0]), width: 1, height: 1 }, deps);
    const [header] = deps.requestMock.mock.calls[0];
    expect((header as { prompt: unknown }).prompt).toEqual({ points: [], box: null, mask: false });
  });

  it('maps the response payload to `mask` and the header polygons to `SegmentResult.polygons`', async () => {
    const deps = makeDeps();
    const result = await segment({ image: new Uint8Array([0]), width: 1, height: 1 }, deps);
    expect(result.mask).toEqual(new Uint8Array([9, 9, 9]));
    expect(result.polygons).toEqual([
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
    ]);
  });

  it('tolerates a missing/malformed polygons field rather than throwing', async () => {
    const deps = makeDeps({
      request: vi.fn(async () => ({ header: { ok: true }, payload: new Uint8Array() })),
    });
    const result = await segment({ image: new Uint8Array([0]), width: 1, height: 1 }, deps);
    expect(result.polygons).toEqual([]);
  });

  it('is a ModelMissingError, with no request sent, when app-kit has no such model', async () => {
    const deps = makeDeps({
      modelDir: vi.fn(async () => {
        throw "Model mobile_sam isn't installed"; // invoke rejects with a plain string
      }),
    });
    await expect(
      segment({ image: new Uint8Array([0]), width: 1, height: 1 }, deps),
    ).rejects.toBeInstanceOf(ModelMissingError);
    expect(deps.requestMock).not.toHaveBeenCalled();
  });

  it('lets any other model_dir failure through as it is', async () => {
    const deps = makeDeps({
      modelDir: vi.fn(async () => {
        throw new Error('store not managed');
      }),
    });
    await expect(
      segment({ image: new Uint8Array([0]), width: 1, height: 1 }, deps),
    ).rejects.toThrow('store not managed');
  });

  it("turns the sidecar's model_missing answer into a ModelMissingError", async () => {
    const deps = makeDeps({
      request: vi.fn(async () => {
        throw new SidecarError('model not installed: mobile_sam', 'model_missing');
      }),
    });
    await expect(
      segment({ image: new Uint8Array([0]), width: 1, height: 1 }, deps),
    ).rejects.toBeInstanceOf(ModelMissingError);
  });

  it('lets another sidecar failure through unchanged', async () => {
    const deps = makeDeps({
      request: vi.fn(async () => {
        throw new SidecarError('bad prompt');
      }),
    });
    await expect(
      segment({ image: new Uint8Array([0]), width: 1, height: 1 }, deps),
    ).rejects.toThrow('bad prompt');
  });

  it('declares the segment capability and calls through the shared driver', async () => {
    expect(typeof sidecarSegmentDriver.segment).toBe('function');
  });
});
