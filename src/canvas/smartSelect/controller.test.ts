import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SegmentOptions, SegmentResult } from '@/ai/adapter';
import { type MarqueeShape, useMarqueeStateStore } from '@/scene/marquee';
import { SmartSelectController, type SmartSelectControllerDeps } from './controller';
import { frameFor } from './coords';
import type { TargetPayload } from './payload';
import { useSmartSelectStore } from './state';

function makePayload(): TargetPayload {
  return {
    image: new Uint8Array(4),
    width: 100,
    height: 50,
    frame: frameFor([200, 100], [100, 50]),
  };
}

/** Deferred-resolve segment stub — tests control exactly when a "request" answers. */
function makeControlledSegment() {
  const calls: SegmentOptions[] = [];
  const resolvers: Array<(r: SegmentResult) => void> = [];
  const rejecters: Array<(e: Error) => void> = [];
  const segment = (options: SegmentOptions): Promise<SegmentResult> => {
    calls.push(options);
    return new Promise<SegmentResult>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    segment,
    calls,
    resolveNext: (result: SegmentResult) => resolvers.shift()?.(result),
    rejectNext: (err: Error) => rejecters.shift()?.(err),
  };
}

function makeDeps(overrides: Partial<SmartSelectControllerDeps> = {}): {
  deps: SmartSelectControllerDeps;
  setMarqueeCalls: Array<MarqueeShape | null>;
} {
  const setMarqueeCalls: Array<MarqueeShape | null> = [];
  const deps: SmartSelectControllerDeps = {
    getPayload: () => makePayload(),
    segment: async () => ({ mask: new Uint8Array(), polygons: [] }),
    setMarquee: (m) => setMarqueeCalls.push(m),
    ...overrides,
  };
  return { deps, setMarqueeCalls };
}

beforeEach(() => {
  vi.useFakeTimers();
  useSmartSelectStore.getState().clear();
  useMarqueeStateStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SmartSelectController', () => {
  it('debounces 150ms after a prompt edit before firing a request', async () => {
    const { segment, calls } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);

    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(1);

    controller.stop();
  });

  it('rapid edits inside the debounce window collapse into a single request', async () => {
    const { segment, calls } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(100);
    useSmartSelectStore.getState().addPoint({ x: 2, y: 2 }, 1);
    await vi.advanceTimersByTimeAsync(100);
    useSmartSelectStore.getState().addPoint({ x: 3, y: 3 }, 0);

    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(1);
    expect(calls[0].points).toHaveLength(3);

    controller.stop();
  });

  it('maps buffer-space points/box through the payload frame before sending', async () => {
    const { segment, calls } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().setBox({ x0: 20, y0: 10, x1: 180, y1: 90 }); // doc space, factor 1/2
    await vi.advanceTimersByTimeAsync(150);

    expect(calls[0].box).toEqual({ x0: 10, y0: 5, x1: 90, y1: 45 });
    expect(calls[0].width).toBe(100);
    expect(calls[0].height).toBe(50);

    controller.stop();
  });

  it('status goes idle -> pending immediately, then downloading after 1s if still unresolved', async () => {
    const { segment } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(useSmartSelectStore.getState().status).toBe('pending');

    await vi.advanceTimersByTimeAsync(999);
    expect(useSmartSelectStore.getState().status).toBe('pending');

    await vi.advanceTimersByTimeAsync(2);
    expect(useSmartSelectStore.getState().status).toBe('downloading');

    controller.stop();
  });

  it('a fast response never shows the downloading state', async () => {
    const { segment, resolveNext } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);

    resolveNext({ mask: new Uint8Array(), polygons: [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(useSmartSelectStore.getState().status).toBe('idle');

    await vi.advanceTimersByTimeAsync(2000);
    expect(useSmartSelectStore.getState().status).toBe('idle'); // the 1s timer must have been cancelled

    controller.stop();
  });

  it('a successful response maps polygons to document space and writes the marquee store', async () => {
    const { segment, resolveNext } = makeControlledSegment();
    const { deps, setMarqueeCalls } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
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
    });

    controller.stop();
  });

  it('an empty polygons response clears the marquee preview', async () => {
    const { segment, resolveNext } = makeControlledSegment();
    const { deps, setMarqueeCalls } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);
    resolveNext({ mask: new Uint8Array(), polygons: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(setMarqueeCalls).toEqual([null]);
    controller.stop();
  });

  it('a request error sets status "error" with the failure message', async () => {
    const { segment, rejectNext } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);
    rejectNext(new Error('sidecar exited'));
    await vi.advanceTimersByTimeAsync(1);

    expect(useSmartSelectStore.getState().status).toBe('error');
    expect(useSmartSelectStore.getState().error).toBe('sidecar exited');

    controller.stop();
  });

  it('a superseded (stale) response is dropped — a newer edit already fired its own request', async () => {
    const { segment, resolveNext, calls } = makeControlledSegment();
    const { deps, setMarqueeCalls } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(1);

    // A second edit, its own debounce, a second request in flight.
    useSmartSelectStore.getState().addPoint({ x: 2, y: 2 }, 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(2);

    // The FIRST (now-stale) request finally answers — must be ignored.
    resolveNext({ mask: new Uint8Array(), polygons: [[{ x: 1, y: 1 }]] });
    await vi.advanceTimersByTimeAsync(1);
    expect(setMarqueeCalls).toHaveLength(0);

    controller.stop();
  });

  it('no payload (nothing cooked yet) sets an error without calling segment', async () => {
    const { segment, calls } = makeControlledSegment();
    const { deps } = makeDeps({ segment, getPayload: () => undefined });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    await vi.advanceTimersByTimeAsync(150);

    expect(calls).toHaveLength(0);
    expect(useSmartSelectStore.getState().status).toBe('error');

    controller.stop();
  });

  it('no target node: an edit never schedules a request', async () => {
    const { segment, calls } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    // setBox with no prior setTarget — targetNodeId stays null.
    useSmartSelectStore.setState({ box: { x0: 0, y0: 0, x1: 1, y1: 1 } });
    await vi.advanceTimersByTimeAsync(200);

    expect(calls).toHaveLength(0);
    controller.stop();
  });

  it('an external marquee clear (e.g. StackRow\'s "Mask from selection" commit) also clears the prompt, not just the marquee — no orphaned point/box markers', async () => {
    const { deps } = makeDeps();
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    useMarqueeStateStore.getState().setMarquee({
      kind: 'polygons',
      polygons: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
    });

    // StackRow's maskFromSelection consumes the marquee via the marquee
    // store's own `clear()` — the controller never sees this call directly.
    useMarqueeStateStore.getState().clear();

    const s = useSmartSelectStore.getState();
    expect(s.points).toEqual([]);
    expect(s.box).toBeNull();
    // Target survives — clearPrompt, not the full clear() a tool-switch uses.
    expect(s.targetNodeId).toBe('node-a');

    controller.stop();
  });

  it('the controller clearing the marquee itself (an empty-polygons response) does NOT also wipe the live prompt', async () => {
    const { segment, resolveNext } = makeControlledSegment();
    const { deps } = makeDeps({
      segment,
      setMarquee: (m) => useMarqueeStateStore.getState().setMarquee(m),
    });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    // A non-null marquee first — the flag only matters at an actual
    // non-null -> null transition; starting from null (as the very first
    // request usually would) can't exercise it at all.
    useMarqueeStateStore.getState().setMarquee({
      kind: 'polygons',
      polygons: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
    });
    await vi.advanceTimersByTimeAsync(150);
    resolveNext({ mask: new Uint8Array(), polygons: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    // The suppress flag must have swallowed this controller-caused null —
    // the user's own point is still there to refine.
    expect(useSmartSelectStore.getState().points).toHaveLength(1);

    controller.stop();
  });

  it('does not leak the suppress flag when the marquee is already null — a later external clear still clears the prompt', async () => {
    const { segment, resolveNext } = makeControlledSegment();
    const { deps } = makeDeps({
      segment,
      setMarquee: (m) => useMarqueeStateStore.getState().setMarquee(m),
    });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    // Marquee starts null (the common "first click, no result yet" case) —
    // this empty response causes NO transition, so the flag must not arm.
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    await vi.advanceTimersByTimeAsync(150);
    resolveNext({ mask: new Uint8Array(), polygons: [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(useMarqueeStateStore.getState().marquee).toBeNull();

    // A later, genuinely external clear (StackRow-style) must still work.
    useMarqueeStateStore.getState().setMarquee({
      kind: 'polygons',
      polygons: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
    });
    useMarqueeStateStore.getState().clear();
    expect(useSmartSelectStore.getState().points).toEqual([]);

    controller.stop();
  });

  it('seam: an outline-seeded document-space box reaches the sidecar mapped to buffer space exactly once, mask omitted (OUTLINE_PROMPT_USES_MASK is off)', async () => {
    const { segment, calls } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    useSmartSelectStore.getState().setTarget('node-a');
    // Mirrors resolveOutlineSeed's own contract: a document-space box, no
    // mask (the default). If outlinePrompt.ts ever computed this bbox in
    // buffer space again, this test — not just outlinePrompt.test.ts's own
    // unit test — would catch the double mapping at the seam.
    useSmartSelectStore.getState().setBox({ x0: 20, y0: 10, x1: 180, y1: 90 });

    await vi.advanceTimersByTimeAsync(150);

    expect(calls[0].box).toEqual({ x0: 10, y0: 5, x1: 90, y1: 45 }); // makePayload()'s frame: factor 1/2
    expect(calls[0].mask).toBeUndefined();

    controller.stop();
  });

  it("activating the tool against an active lasso survives Viewport.tsx's own outline-consuming clearMarquee() — the request still fires", async () => {
    const { segment, calls } = makeControlledSegment();
    const { deps } = makeDeps({ segment });
    const controller = new SmartSelectController(deps);
    controller.start();

    // The outline about to be consumed — a lasso, NOT this tool's own
    // polygons preview. Mirrors Viewport.tsx's activation sequence exactly:
    // seed the prompt from the active marquee, THEN clearMarquee() to
    // consume it.
    useMarqueeStateStore
      .getState()
      .setMarquee({ kind: 'lasso', points: [{ x: 0, y: 0 }], closed: true });
    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().setBox({ x0: 20, y0: 10, x1: 180, y1: 90 });
    useMarqueeStateStore.getState().clear(); // Viewport.tsx's clearMarquee()

    await vi.advanceTimersByTimeAsync(150);

    // If the marquee-store subscription reacted to this (non-polygons)
    // clear, `clearPrompt()` would have wiped the box before the debounce
    // fired and nothing would have been sent.
    expect(calls).toHaveLength(1);
    expect(calls[0].box).toEqual({ x0: 10, y0: 5, x1: 90, y1: 45 });

    controller.stop();
  });
});
