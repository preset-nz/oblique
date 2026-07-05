import { beforeEach, describe, expect, it } from 'vitest';
import * as history from '@/scene/history';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import {
  DEFAULT_MARQUEE_PARAMS,
  isMaskableMarquee,
  marqueeToMaskShape,
  useMarqueeStateStore,
} from './marquee';

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

describe('isMaskableMarquee', () => {
  it('accepts a drawn rect/ellipse, rejects a degenerate one', () => {
    expect(isMaskableMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 10, h: 10 } })).toBe(true);
    expect(isMaskableMarquee({ kind: 'ellipse', rect: { x: 0, y: 0, w: 10, h: 10 } })).toBe(true);
    expect(isMaskableMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 0.5, h: 10 } })).toBe(false);
    expect(isMaskableMarquee(null)).toBe(false);
  });

  it('accepts only a closed lasso with enough points', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    expect(isMaskableMarquee({ kind: 'lasso', points, closed: true })).toBe(true);
    expect(isMaskableMarquee({ kind: 'lasso', points, closed: false })).toBe(false);
    expect(isMaskableMarquee({ kind: 'lasso', points: points.slice(0, 2), closed: true })).toBe(
      false,
    );
  });
});

describe('marqueeToMaskShape', () => {
  it('passes rect/ellipse geometry through and drops the lasso closed flag', () => {
    expect(marqueeToMaskShape({ kind: 'ellipse', rect: { x: 1, y: 2, w: 3, h: 4 } })).toEqual({
      kind: 'ellipse',
      rect: { x: 1, y: 2, w: 3, h: 4 },
    });
    expect(marqueeToMaskShape({ kind: 'lasso', points: [{ x: 1, y: 1 }], closed: true })).toEqual({
      kind: 'lasso',
      points: [{ x: 1, y: 1 }],
    });
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
