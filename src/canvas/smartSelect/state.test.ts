import { beforeEach, describe, expect, it } from 'vitest';
import { hasPrompt, useSmartSelectStore } from './state';

beforeEach(() => {
  useSmartSelectStore.getState().clear();
  useSmartSelectStore.setState({ targetNodeId: null });
});

describe('smartSelect state store', () => {
  it('defaults to no target and an empty prompt', () => {
    const s = useSmartSelectStore.getState();
    expect(s.targetNodeId).toBeNull();
    expect(s.points).toEqual([]);
    expect(s.box).toBeNull();
    expect(s.outlineMask).toBeNull();
    expect(s.status).toBe('idle');
  });

  it('setTarget activates against a node and discards any previous prompt', () => {
    useSmartSelectStore.getState().addPoint({ x: 1, y: 2 }, 1);
    useSmartSelectStore.getState().setTarget('node-a');
    const s = useSmartSelectStore.getState();
    expect(s.targetNodeId).toBe('node-a');
    expect(s.points).toEqual([]);
  });

  it('addPoint appends a labelled point (1 = positive, 0 = negative)', () => {
    useSmartSelectStore.getState().addPoint({ x: 1, y: 2 }, 1);
    useSmartSelectStore.getState().addPoint({ x: 3, y: 4 }, 0);
    expect(useSmartSelectStore.getState().points).toEqual([
      { x: 1, y: 2, label: 1 },
      { x: 3, y: 4, label: 0 },
    ]);
  });

  it('setBox replaces the whole prompt: clears prior points and any outline seed', () => {
    useSmartSelectStore.getState().addPoint({ x: 1, y: 2 }, 1);
    useSmartSelectStore.getState().seedOutline({ x0: 0, y0: 0, x1: 1, y1: 1 }, new Uint8Array(4));
    useSmartSelectStore.getState().setBox({ x0: 5, y0: 5, x1: 15, y1: 15 });
    const s = useSmartSelectStore.getState();
    expect(s.box).toEqual({ x0: 5, y0: 5, x1: 15, y1: 15 });
    expect(s.points).toEqual([]);
    expect(s.outlineMask).toBeNull();
  });

  it('addPoint after setBox refines the existing box (does not clear it)', () => {
    useSmartSelectStore.getState().setBox({ x0: 5, y0: 5, x1: 15, y1: 15 });
    useSmartSelectStore.getState().addPoint({ x: 10, y: 10 }, 1);
    const s = useSmartSelectStore.getState();
    expect(s.box).toEqual({ x0: 5, y0: 5, x1: 15, y1: 15 });
    expect(s.points).toEqual([{ x: 10, y: 10, label: 1 }]);
  });

  it('seedOutline sets box + coarse mask, and addPoint afterwards refines it without clearing the mask', () => {
    const mask = new Uint8Array(256 * 256).fill(1);
    useSmartSelectStore.getState().seedOutline({ x0: 1, y0: 1, x1: 9, y1: 9 }, mask);
    useSmartSelectStore.getState().addPoint({ x: 5, y: 5 }, 0);
    const s = useSmartSelectStore.getState();
    expect(s.box).toEqual({ x0: 1, y0: 1, x1: 9, y1: 9 });
    expect(s.outlineMask).toBe(mask);
    expect(s.points).toEqual([{ x: 5, y: 5, label: 0 }]);
  });

  it('setStatus records status and an optional error, clearing error when absent', () => {
    useSmartSelectStore.getState().setStatus('model_missing');
    expect(useSmartSelectStore.getState()).toMatchObject({ status: 'model_missing', error: null });
    useSmartSelectStore.getState().setStatus('error', 'sidecar not running');
    expect(useSmartSelectStore.getState()).toMatchObject({
      status: 'error',
      error: 'sidecar not running',
    });
  });

  it('clear resets to the pristine default, including the target', () => {
    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    useSmartSelectStore.getState().setStatus('pending');
    useSmartSelectStore.getState().clear();
    const s = useSmartSelectStore.getState();
    expect(s.targetNodeId).toBeNull();
    expect(s.points).toEqual([]);
    expect(s.status).toBe('idle');
  });

  it('clearPrompt drops points/box/outline/status but keeps the target — the tool stays usable without a re-activation round trip', () => {
    useSmartSelectStore.getState().setTarget('node-a');
    useSmartSelectStore.getState().addPoint({ x: 1, y: 1 }, 1);
    useSmartSelectStore.getState().setStatus('error', 'boom');
    useSmartSelectStore.getState().clearPrompt();
    const s = useSmartSelectStore.getState();
    expect(s.targetNodeId).toBe('node-a');
    expect(s.points).toEqual([]);
    expect(s.box).toBeNull();
    expect(s.outlineMask).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
  });
});

describe('hasPrompt', () => {
  it('false with neither points nor a box', () => {
    expect(hasPrompt({ points: [], box: null })).toBe(false);
  });

  it('true with at least one point', () => {
    expect(hasPrompt({ points: [{ x: 0, y: 0, label: 1 }], box: null })).toBe(true);
  });

  it('true with a box and no points', () => {
    expect(hasPrompt({ points: [], box: { x0: 0, y0: 0, x1: 1, y1: 1 } })).toBe(true);
  });
});
