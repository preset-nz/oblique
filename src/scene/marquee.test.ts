import { beforeEach, describe, expect, it } from 'vitest';
import * as history from '@/scene/history';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import {
  DEFAULT_MARQUEE_PARAMS,
  fillRuleForMarquee,
  isMaskableMarquee,
  KAPPA,
  marqueeToVectorPaths,
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

  it('accepts a polygons marquee with at least one polygon of >= 3 points', () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    expect(isMaskableMarquee({ kind: 'polygons', polygons: [triangle] })).toBe(true);
    expect(
      isMaskableMarquee({ kind: 'polygons', polygons: [triangle.slice(0, 2), triangle] }),
    ).toBe(true);
    expect(isMaskableMarquee({ kind: 'polygons', polygons: [triangle.slice(0, 2)] })).toBe(false);
    expect(isMaskableMarquee({ kind: 'polygons', polygons: [] })).toBe(false);
  });
});

describe('marqueeToVectorPaths', () => {
  it('rect: 4 corner anchors clockwise from top-left, no handles, closed', () => {
    const paths = marqueeToVectorPaths({ kind: 'rect', rect: { x: 10, y: 20, w: 30, h: 40 } });
    expect(paths).toHaveLength(1);
    const [path] = paths;
    expect(path.closed).toBe(true);
    expect(path.anchors).toEqual([
      { point: { x: 10, y: 20 } },
      { point: { x: 40, y: 20 } },
      { point: { x: 40, y: 60 } },
      { point: { x: 10, y: 60 } },
    ]);
    for (const anchor of path.anchors) {
      expect(anchor.handleIn).toBeUndefined();
      expect(anchor.handleOut).toBeUndefined();
    }
  });

  it('lasso: exactly points.length anchors, all handle-less, closed', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 3, y: 5 },
    ];
    const paths = marqueeToVectorPaths({ kind: 'lasso', points, closed: true });
    expect(paths).toHaveLength(1);
    const [path] = paths;
    expect(path.closed).toBe(true);
    expect(path.anchors).toHaveLength(points.length);
    expect(path.anchors.map((a) => a.point)).toEqual(points);
    for (const anchor of path.anchors) {
      expect(anchor.handleIn).toBeUndefined();
      expect(anchor.handleOut).toBeUndefined();
    }
  });

  it('ellipse: 4 anchors at axis midpoints with KAPPA-scaled cubic handles, closed', () => {
    const paths = marqueeToVectorPaths({ kind: 'ellipse', rect: { x: 0, y: 0, w: 200, h: 100 } });
    expect(paths).toHaveLength(1);
    const [path] = paths;
    expect(path.closed).toBe(true);
    expect(path.anchors).toHaveLength(4);

    const cx = 100;
    const cy = 50;
    const rx = 100;
    const ry = 50;
    const kx = KAPPA * rx;
    const ky = KAPPA * ry;

    const [top, right, bottom, left] = path.anchors;
    expect(top.point).toEqual({ x: cx, y: 0 });
    expect(top.handleIn).toEqual({ x: cx - kx, y: 0 });
    expect(top.handleOut).toEqual({ x: cx + kx, y: 0 });

    expect(right.point).toEqual({ x: 200, y: cy });
    expect(right.handleIn).toEqual({ x: 200, y: cy - ky });
    expect(right.handleOut).toEqual({ x: 200, y: cy + ky });

    expect(bottom.point).toEqual({ x: cx, y: 100 });
    expect(bottom.handleIn).toEqual({ x: cx + kx, y: 100 });
    expect(bottom.handleOut).toEqual({ x: cx - kx, y: 100 });

    expect(left.point).toEqual({ x: 0, y: cy });
    expect(left.handleIn).toEqual({ x: 0, y: cy + ky });
    expect(left.handleOut).toEqual({ x: 0, y: cy - ky });
  });

  /**
   * Acceptance's "rasterised alpha differs < 2% of pixels" can't run
   * headlessly — this repo's vitest has no DOM/OffscreenCanvas (no jsdom
   * dependency, no `environment` config), so `rasterizeVectorMask`
   * (`OffscreenCanvas`-only, production-only per its doc comment) can't
   * execute here. Standing in with the analytic
   * claim the story itself makes: the 4-cubic approximation is within
   * 0.03% radial error of the true ellipse. If that holds, a Canvas 2D fill
   * of the two shapes cannot meaningfully differ in rasterised pixels.
   */
  it('the 4-cubic approximation stays within 0.03% radial error of the true ellipse', () => {
    const rect = { x: 0, y: 0, w: 200, h: 120 };
    const [path] = marqueeToVectorPaths({ kind: 'ellipse', rect });
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const rx = rect.w / 2;
    const ry = rect.h / 2;

    function cubicPoint(
      p0: { x: number; y: number },
      p1: { x: number; y: number },
      p2: { x: number; y: number },
      p3: { x: number; y: number },
      t: number,
    ) {
      const u = 1 - t;
      const x = u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x;
      const y = u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y;
      return { x, y };
    }

    let maxRelError = 0;
    for (let seg = 0; seg < 4; seg++) {
      const a0 = path.anchors[seg];
      const a1 = path.anchors[(seg + 1) % 4];
      const p0 = a0.point;
      const p1 = a0.handleOut ?? a0.point;
      const p2 = a1.handleIn ?? a1.point;
      const p3 = a1.point;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const { x, y } = cubicPoint(p0, p1, p2, p3, t);
        // Normalised radial distance from the ellipse centre (1 == on the
        // true ellipse boundary, in the ellipse's own unit-circle frame).
        const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
        maxRelError = Math.max(maxRelError, Math.abs(r - 1));
      }
    }
    expect(maxRelError).toBeLessThan(0.0003);
  });

  it('polygons: one closed handle-less path per contour, document space in, document space out', () => {
    const a = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ];
    const b = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ];
    const paths = marqueeToVectorPaths({ kind: 'polygons', polygons: [a, b] });
    expect(paths).toHaveLength(2);
    expect(paths[0].closed).toBe(true);
    expect(paths[0].anchors.map((anchor) => anchor.point)).toEqual(a);
    expect(paths[1].closed).toBe(true);
    expect(paths[1].anchors.map((anchor) => anchor.point)).toEqual(b);
    for (const path of paths) {
      for (const anchor of path.anchors) {
        expect(anchor.handleIn).toBeUndefined();
        expect(anchor.handleOut).toBeUndefined();
      }
    }
  });
});

describe('fillRuleForMarquee (colour-range-select.md)', () => {
  it('polygons rasterises evenodd — trace.py is winding-agnostic, so it is the only rule that reliably cuts holes', () => {
    expect(fillRuleForMarquee({ kind: 'polygons', polygons: [] })).toBe('evenodd');
  });

  it('rect/ellipse/lasso stay nonzero — single simple loops, no holes possible', () => {
    expect(fillRuleForMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 1, h: 1 } })).toBe('nonzero');
    expect(fillRuleForMarquee({ kind: 'ellipse', rect: { x: 0, y: 0, w: 1, h: 1 } })).toBe(
      'nonzero',
    );
    expect(fillRuleForMarquee({ kind: 'lasso', points: [], closed: true })).toBe('nonzero');
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
