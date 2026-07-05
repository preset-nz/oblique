import { describe, expect, it } from 'vitest';
import type { Transform2D, VectorPath } from '@/scene/types';
import { IDENTITY_TRANSFORM_2D } from '@/scene/types';
import { localToWorld, type NodeExtent, worldToLocal } from '../transform2d';
import { localDistanceThreshold, mapAnchor, mapVectorPaths } from './vectorTransform';

const extent: NodeExtent = { w: 200, h: 100 };

const movedScaled: Transform2D = {
  x: 50,
  y: -20,
  scaleX: 2,
  scaleY: 0.5,
  rotation: Math.PI / 6, // 30 degrees
};

const path: VectorPath = {
  closed: true,
  anchors: [
    { point: { x: 10, y: 10 }, handleOut: { x: 20, y: 10 } },
    { point: { x: 190, y: 90 }, handleIn: { x: 150, y: 80 } },
  ],
};

describe('mapAnchor', () => {
  it('maps point and defined handles, leaves undefined handles undefined', () => {
    const fn = (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 3 });
    const result = mapAnchor(path.anchors[0], fn);
    expect(result.point).toEqual({ x: 20, y: 30 });
    expect(result.handleOut).toEqual({ x: 40, y: 30 });
    expect(result.handleIn).toBeUndefined();
  });
});

describe('mapVectorPaths', () => {
  it('maps every anchor of every path via localToWorld and matches localToWorld point-by-point', () => {
    const toWorld = (p: { x: number; y: number }) => localToWorld(p, movedScaled, extent);
    const worldPaths = mapVectorPaths([path], toWorld);

    expect(worldPaths).toHaveLength(1);
    expect(worldPaths[0].closed).toBe(true);
    path.anchors.forEach((anchor, i) => {
      expect(worldPaths[0].anchors[i].point).toEqual(
        localToWorld(anchor.point, movedScaled, extent),
      );
    });
    const handleOut = path.anchors[0].handleOut;
    const handleIn = path.anchors[1].handleIn;
    if (!handleOut || !handleIn) throw new Error('expected fixture handles to be defined');
    expect(worldPaths[0].anchors[0].handleOut).toEqual(
      localToWorld(handleOut, movedScaled, extent),
    );
    expect(worldPaths[0].anchors[1].handleIn).toEqual(localToWorld(handleIn, movedScaled, extent));
  });

  it('round-trips through worldToLocal back to the original local points', () => {
    const toWorld = (p: { x: number; y: number }) => localToWorld(p, movedScaled, extent);
    const toLocal = (p: { x: number; y: number }) => worldToLocal(p, movedScaled, extent);
    const worldPaths = mapVectorPaths([path], toWorld);
    const roundTripped = mapVectorPaths(worldPaths, toLocal);

    roundTripped[0].anchors.forEach((anchor, i) => {
      expect(anchor.point.x).toBeCloseTo(path.anchors[i].point.x, 9);
      expect(anchor.point.y).toBeCloseTo(path.anchors[i].point.y, 9);
    });
  });

  it('is a no-op under the identity transform', () => {
    const toWorld = (p: { x: number; y: number }) => localToWorld(p, IDENTITY_TRANSFORM_2D, extent);
    const worldPaths = mapVectorPaths([path], toWorld);
    expect(worldPaths[0].anchors[0].point).toEqual(path.anchors[0].point);
    expect(worldPaths[0].anchors[1].point).toEqual(path.anchors[1].point);
  });
});

describe('localDistanceThreshold', () => {
  it('is unchanged under the identity transform', () => {
    expect(localDistanceThreshold(6, IDENTITY_TRANSFORM_2D)).toBeCloseTo(6, 9);
  });

  it('divides by the larger of |scaleX| / |scaleY| (max-axis choice)', () => {
    // scaleX=2, scaleY=0.5 -> max axis magnitude is 2.
    expect(localDistanceThreshold(6, movedScaled)).toBeCloseTo(3, 9);
  });

  it('handles negative scale (mirrored node) by magnitude', () => {
    const t: Transform2D = { ...IDENTITY_TRANSFORM_2D, scaleX: -4, scaleY: 1 };
    expect(localDistanceThreshold(8, t)).toBeCloseTo(2, 9);
  });

  it('never divides by (near-)zero scale', () => {
    const t: Transform2D = { ...IDENTITY_TRANSFORM_2D, scaleX: 0, scaleY: 0 };
    expect(Number.isFinite(localDistanceThreshold(6, t))).toBe(true);
  });
});
