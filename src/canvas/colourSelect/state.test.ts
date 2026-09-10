import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLOUR_SELECT_PARAMS } from '@/ai/sidecarSelectColour';
import { hasSeeds, useColourSelectStore } from './state';

beforeEach(() => {
  useColourSelectStore.getState().clear();
  useColourSelectStore.setState({ targetNodeId: null });
});

describe('colourSelect state store', () => {
  it('defaults to no target, no seeds, and the story-default params', () => {
    const s = useColourSelectStore.getState();
    expect(s.targetNodeId).toBeNull();
    expect(s.seeds).toEqual([]);
    expect(s.params).toEqual(DEFAULT_COLOUR_SELECT_PARAMS);
    expect(s.status).toBe('idle');
  });

  it('setTarget activates against a node, discards any previous seeds, but keeps params', () => {
    useColourSelectStore.getState().setParams({ tolerance: 99 });
    useColourSelectStore.getState().setSeed({ x: 1, y: 2 }, 1);
    useColourSelectStore.getState().setTarget('node-a');
    const s = useColourSelectStore.getState();
    expect(s.targetNodeId).toBe('node-a');
    expect(s.seeds).toEqual([]);
    expect(s.params.tolerance).toBe(99);
  });

  it('setSeed (plain click) replaces the whole seed set with just this one', () => {
    useColourSelectStore.getState().setSeed({ x: 1, y: 2 }, 1);
    useColourSelectStore.getState().setSeed({ x: 3, y: 4 }, 0);
    expect(useColourSelectStore.getState().seeds).toEqual([{ x: 3, y: 4, label: 0 }]);
  });

  it('addSeed (shift-click) appends to the existing seed set', () => {
    useColourSelectStore.getState().setSeed({ x: 1, y: 2 }, 1);
    useColourSelectStore.getState().addSeed({ x: 3, y: 4 }, 0);
    expect(useColourSelectStore.getState().seeds).toEqual([
      { x: 1, y: 2, label: 1 },
      { x: 3, y: 4, label: 0 },
    ]);
  });

  it('setParams patches only the given keys', () => {
    useColourSelectStore.getState().setParams({ tolerance: 64, contiguous: false });
    const s = useColourSelectStore.getState();
    expect(s.params.tolerance).toBe(64);
    expect(s.params.contiguous).toBe(false);
    expect(s.params.space).toBe(DEFAULT_COLOUR_SELECT_PARAMS.space);
  });

  it('setStatus records status and an optional error, clearing error when absent', () => {
    useColourSelectStore.getState().setStatus('pending');
    expect(useColourSelectStore.getState()).toMatchObject({ status: 'pending', error: null });
    useColourSelectStore.getState().setStatus('error', 'sidecar not running');
    expect(useColourSelectStore.getState()).toMatchObject({
      status: 'error',
      error: 'sidecar not running',
    });
  });

  it('clear resets to the pristine default, including the target and params', () => {
    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    useColourSelectStore.getState().setParams({ tolerance: 200 });
    useColourSelectStore.getState().setStatus('pending');
    useColourSelectStore.getState().clear();
    const s = useColourSelectStore.getState();
    expect(s.targetNodeId).toBeNull();
    expect(s.seeds).toEqual([]);
    expect(s.params).toEqual(DEFAULT_COLOUR_SELECT_PARAMS);
    expect(s.status).toBe('idle');
  });

  it('clearPrompt drops seeds/status but keeps the target AND params — the tool stays usable without a re-activation round trip', () => {
    useColourSelectStore.getState().setTarget('node-a');
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    useColourSelectStore.getState().setParams({ tolerance: 200 });
    useColourSelectStore.getState().setStatus('error', 'boom');
    useColourSelectStore.getState().clearPrompt();
    const s = useColourSelectStore.getState();
    expect(s.targetNodeId).toBe('node-a');
    expect(s.seeds).toEqual([]);
    expect(s.params.tolerance).toBe(200);
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
  });
});

describe('hasSeeds', () => {
  it('false with no seeds', () => {
    expect(hasSeeds({ seeds: [] })).toBe(false);
  });

  it('true with at least one seed', () => {
    expect(hasSeeds({ seeds: [{ x: 0, y: 0, label: 1 }] })).toBe(true);
  });
});
