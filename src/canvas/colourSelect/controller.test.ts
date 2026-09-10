import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectColourOptions, SelectColourResult } from '@/ai/sidecarSelectColour';
import { DEFAULT_COLOUR_SELECT_PARAMS } from '@/ai/sidecarSelectColour';
import { type MarqueeShape, useMarqueeStateStore } from '@/scene/marquee';
import { frameFor } from '../selectShared/coords';
import type { TargetPayload } from '../selectShared/payload';
import { ColourSelectController, type ColourSelectControllerDeps } from './controller';
import { useColourSelectStore } from './state';

function makePayload(): TargetPayload {
  return {
    image: new Uint8Array(4),
    width: 100,
    height: 50,
    frame: frameFor([200, 100], [100, 50]),
  };
}

/** Deferred-resolve stub — tests control exactly when a "request" answers, same pattern as `smartSelect/controller.test.ts`'s `makeControlledSegment`. */
function makeControlledSelectColour() {
  const calls: SelectColourOptions[] = [];
  const resolvers: Array<(r: SelectColourResult) => void> = [];
  const rejecters: Array<(e: Error) => void> = [];
  const selectColour = (options: SelectColourOptions): Promise<SelectColourResult> => {
    calls.push(options);
    return new Promise<SelectColourResult>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    selectColour,
    calls,
    resolveNext: (result: SelectColourResult) => resolvers.shift()?.(result),
    rejectNext: (err: Error) => rejecters.shift()?.(err),
  };
}

function makeDeps(overrides: Partial<ColourSelectControllerDeps> = {}): {
  deps: ColourSelectControllerDeps;
  setMarqueeCalls: Array<MarqueeShape | null>;
} {
  const setMarqueeCalls: Array<MarqueeShape | null> = [];
  const deps: ColourSelectControllerDeps = {
    getPayload: () => makePayload(),
    selectColour: async () => ({ mask: new Uint8Array(), polygons: [] }),
    setMarquee: (m) => setMarqueeCalls.push(m),
    ...overrides,
  };
  return { deps, setMarqueeCalls };
}

beforeEach(() => {
  vi.useFakeTimers();
  useColourSelectStore.getState().clear();
  useMarqueeStateStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ColourSelectController', () => {
  it('debounces 150ms after a seed edit before firing a request', async () => {
    const { selectColour, calls } = makeControlledSelectColour();
    const { deps } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);

    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(1);

    controller.stop();
  });

  it('rapid edits inside the debounce window collapse into a single request', async () => {
    const { selectColour, calls } = makeControlledSelectColour();
    const { deps } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(100);
    useColourSelectStore.getState().addSeed({ x: 2, y: 2 }, 1);
    await vi.advanceTimersByTimeAsync(100);
    useColourSelectStore.getState().setParams({ tolerance: 60 });

    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(1);
    expect(calls[0].seeds).toHaveLength(2);
    expect(calls[0].params.tolerance).toBe(60);

    controller.stop();
  });

  it('maps buffer-space seeds through the payload frame before sending', async () => {
    const { selectColour, calls } = makeControlledSelectColour();
    const { deps } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 20, y: 10 }, 1); // doc space, factor 1/2
    await vi.advanceTimersByTimeAsync(150);

    expect(calls[0].seeds).toEqual([{ x: 10, y: 5, label: 1 }]);
    expect(calls[0].width).toBe(100);
    expect(calls[0].height).toBe(50);

    controller.stop();
  });

  it("sends the current params verbatim (camelCase field names, the sidecar snake_case mapping is sidecarSelectColour.ts's job)", async () => {
    const { selectColour, calls } = makeControlledSelectColour();
    const { deps } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 0, y: 0 }, 1);
    await vi.advanceTimersByTimeAsync(150);

    expect(calls[0].params).toEqual(DEFAULT_COLOUR_SELECT_PARAMS);

    controller.stop();
  });

  it('a successful response paints the polygons preview labelled "Selection (colour)"', async () => {
    const { selectColour, resolveNext } = makeControlledSelectColour();
    const { deps, setMarqueeCalls } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);

    resolveNext({
      mask: new Uint8Array(),
      polygons: [
        [
          { x: 10, y: 5 },
          { x: 90, y: 5 },
          { x: 50, y: 45 },
        ],
      ],
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(setMarqueeCalls).toHaveLength(1);
    expect(setMarqueeCalls[0]).toEqual({
      kind: 'polygons',
      polygons: [
        [
          { x: 20, y: 10 },
          { x: 180, y: 10 },
          { x: 100, y: 90 },
        ],
      ],
      label: 'Selection (colour)',
    });
    expect(useColourSelectStore.getState().status).toBe('idle');

    controller.stop();
  });

  it('an empty polygons response clears the marquee preview', async () => {
    const { selectColour, resolveNext } = makeControlledSelectColour();
    const { deps, setMarqueeCalls } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);
    resolveNext({ mask: new Uint8Array(), polygons: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(setMarqueeCalls).toEqual([null]);

    controller.stop();
  });

  it('a rejected request sets status error with the message', async () => {
    const { selectColour, rejectNext } = makeControlledSelectColour();
    const { deps } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);
    rejectNext(new Error('sidecar exploded'));
    await vi.advanceTimersByTimeAsync(1);

    expect(useColourSelectStore.getState()).toMatchObject({
      status: 'error',
      error: 'sidecar exploded',
    });

    controller.stop();
  });

  it("a superseded (out-of-order) response is dropped — only the newest edit's result lands", async () => {
    const { selectColour, resolveNext } = makeControlledSelectColour();
    const { deps, setMarqueeCalls } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150); // first request fires

    useColourSelectStore.getState().addSeed({ x: 2, y: 2 }, 1);
    await vi.advanceTimersByTimeAsync(150); // second request fires

    // Resolve the FIRST (now-stale) request last.
    resolveNext({ mask: new Uint8Array(), polygons: [[{ x: 0, y: 0 }]] });
    await vi.advanceTimersByTimeAsync(1);

    expect(setMarqueeCalls).toHaveLength(0); // the stale response never painted

    controller.stop();
  });

  it('setTarget with no target never fires (nothing to select from)', async () => {
    const { selectColour, calls } = makeControlledSelectColour();
    const { deps } = makeDeps({ selectColour });
    const controller = new ColourSelectController(deps);
    controller.start();

    // setSeed with no prior setTarget — targetNodeId stays null.
    useColourSelectStore.setState({ seeds: [{ x: 0, y: 0, label: 1 }] });
    await vi.advanceTimersByTimeAsync(200);

    expect(calls).toHaveLength(0);
    controller.stop();
  });

  it('an external marquee clear (StackRow\'s "Mask from selection" commit) also clears the seeds', async () => {
    const { deps } = makeDeps();
    const controller = new ColourSelectController(deps);
    controller.start();

    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    useMarqueeStateStore.getState().setMarquee({
      kind: 'polygons',
      polygons: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
      label: 'Selection (colour)',
    });

    useMarqueeStateStore.getState().clear();

    const s = useColourSelectStore.getState();
    expect(s.seeds).toEqual([]);
    expect(s.targetNodeId).toBe('node-a'); // target survives — clearPrompt, not clear()

    controller.stop();
  });
});
