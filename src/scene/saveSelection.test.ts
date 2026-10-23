import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MARQUEE_PARAMS, type MarqueeShape, useMarqueeStateStore } from './marquee';
import { saveActiveSelection } from './saveSelection';
import { useSelectionStore } from './selection';
import { useSceneStore } from './store';
import type { Scene } from './types';

function emptyScene(): Scene {
  return {
    id: 'scene-1',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [100, 100],
  };
}

const rect: MarqueeShape = { kind: 'rect', rect: { x: 1, y: 2, w: 30, h: 40 } };

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useMarqueeStateStore.setState({ marquee: null, params: DEFAULT_MARQUEE_PARAMS });
  useSelectionStore.getState().clear();
});

describe('saveActiveSelection (save-selection.md)', () => {
  it('saves the marquee, clears it and selects the new node', () => {
    useMarqueeStateStore.getState().setMarquee(rect);
    useMarqueeStateStore.getState().setParams({ featherPx: 5 });
    const id = saveActiveSelection();
    expect(id).toBeDefined();
    const { nodes } = useSceneStore.getState().scene;
    expect(nodes.map((n) => n.id)).toEqual([id]);
    expect(nodes[0]).toMatchObject({
      label: 'Selection (rect)',
      role: 'selection',
      visible: false,
    });
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    // feather and the rest belong to a mask reference: cleared with the marquee, not saved
    expect(useMarqueeStateStore.getState().params).toEqual(DEFAULT_MARQUEE_PARAMS);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: id });
  });

  it('is a no-op without a marquee', () => {
    const before = useSceneStore.getState().scene;
    expect(saveActiveSelection()).toBeUndefined();
    expect(useSceneStore.getState().scene).toBe(before);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'none' });
  });

  it('is a no-op for a marquee that is not finished, and leaves it up', () => {
    const lasso: MarqueeShape = { kind: 'lasso', points: [{ x: 0, y: 0 }], closed: false };
    useMarqueeStateStore.getState().setMarquee(lasso);
    const before = useSceneStore.getState().scene;
    expect(saveActiveSelection()).toBeUndefined();
    expect(useSceneStore.getState().scene).toBe(before);
    expect(useMarqueeStateStore.getState().marquee).toBe(lasso);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'none' });
  });
});
