import { beforeEach, describe, expect, it } from 'vitest';
import * as history from '@/scene/history';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import { DEFAULT_MARQUEE_PARAMS, useMarqueeStateStore } from './marqueeState';

function emptyScene(): Scene {
  return {
    id: 'scene-1',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [0, 0],
  };
}

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  history.clear();
  useMarqueeStateStore.setState({ marquee: null, params: DEFAULT_MARQUEE_PARAMS });
});

describe('marquee state store', () => {
  it('defaults to no active marquee and default params', () => {
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    expect(useMarqueeStateStore.getState().params).toEqual(DEFAULT_MARQUEE_PARAMS);
  });

  it('setMarquee sets the one active marquee', () => {
    useMarqueeStateStore
      .getState()
      .setMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 10, h: 10 } });
    expect(useMarqueeStateStore.getState().marquee).toEqual({
      kind: 'rect',
      rect: { x: 0, y: 0, w: 10, h: 10 },
    });
  });

  it('setParams patches feather/expand/invert independently', () => {
    useMarqueeStateStore.getState().setParams({ featherPx: 4 });
    expect(useMarqueeStateStore.getState().params).toEqual({
      ...DEFAULT_MARQUEE_PARAMS,
      featherPx: 4,
    });
  });

  it('clear drops the marquee and resets params (no orphaned toolbar state)', () => {
    useMarqueeStateStore.getState().setMarquee({ kind: 'lasso', points: [], closed: true });
    useMarqueeStateStore.getState().setParams({ invert: true, featherPx: 10 });
    useMarqueeStateStore.getState().clear();
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    expect(useMarqueeStateStore.getState().params).toEqual(DEFAULT_MARQUEE_PARAMS);
  });
});

describe('marquee state never touches the scene store', () => {
  it('every mutation leaves the scene reference and undo stack untouched', () => {
    const sceneBefore = useSceneStore.getState().scene;

    useMarqueeStateStore.getState().setMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 5, h: 5 } });
    useMarqueeStateStore.getState().setParams({ expand: 2 });
    useMarqueeStateStore.getState().clear();

    expect(useSceneStore.getState().scene).toBe(sceneBefore);
    expect(history.canUndo()).toBe(false);
  });
});
