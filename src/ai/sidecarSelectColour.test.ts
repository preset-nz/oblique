import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COLOUR_SELECT_PARAMS,
  type SidecarSelectColourDeps,
  selectColour,
} from './sidecarSelectColour';

function makeDeps(
  overrides: Partial<SidecarSelectColourDeps> = {},
): SidecarSelectColourDeps & { requestMock: ReturnType<typeof vi.fn> } {
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
  return { request: requestMock, requestMock, ...overrides };
}

describe('selectColour (sidecarSelectColour.ts)', () => {
  it('sends op: select_colour with seeds and snake_case params', async () => {
    const deps = makeDeps();
    await selectColour(
      {
        image: new Uint8Array([1, 2, 3, 4]),
        width: 10,
        height: 5,
        seeds: [{ x: 1, y: 2, label: 1 }],
        params: DEFAULT_COLOUR_SELECT_PARAMS,
      },
      deps,
    );

    expect(deps.requestMock).toHaveBeenCalledTimes(1);
    const [header, payload] = deps.requestMock.mock.calls[0];
    expect(header).toEqual({
      op: 'select_colour',
      width: 10,
      height: 5,
      seeds: [{ x: 1, y: 2, label: 1 }],
      params: {
        tolerance: 32,
        contiguous: true,
        space: 'lab',
        expand: 0,
        min_island: 16,
      },
    });
    expect(payload).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('parses the response into mask + polygons', async () => {
    const deps = makeDeps();
    const result = await selectColour(
      {
        image: new Uint8Array(4),
        width: 10,
        height: 5,
        seeds: [{ x: 0, y: 0, label: 1 }],
        params: DEFAULT_COLOUR_SELECT_PARAMS,
      },
      deps,
    );

    expect(result.mask).toEqual(new Uint8Array([9, 9, 9]));
    expect(result.polygons).toEqual([
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
    ]);
  });

  it('tolerates a missing/malformed polygons field as "no polygons"', async () => {
    const deps = makeDeps({
      request: vi.fn(async () => ({ header: { ok: true }, payload: new Uint8Array() })),
    });
    const result = await selectColour(
      {
        image: new Uint8Array(4),
        width: 1,
        height: 1,
        seeds: [{ x: 0, y: 0, label: 1 }],
        params: DEFAULT_COLOUR_SELECT_PARAMS,
      },
      deps,
    );
    expect(result.polygons).toEqual([]);
  });
});
