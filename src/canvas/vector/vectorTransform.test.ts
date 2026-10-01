import { describe, expect, it } from 'vitest';
import type { Transform2D, VectorPath } from '@/scene/types';
import { IDENTITY_TRANSFORM_2D } from '@/scene/types';
import { maskDisplayTransform } from '../maskDisplayTransform';
import { localToWorld, type NodeExtent, worldToLocal } from '../transform2d';
import {
  localDistanceThreshold,
  mapAnchor,
  mapVectorPaths,
  vectorPointMaps,
} from './vectorTransform';

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

describe('vectorPointMaps — node-pinned mask delta (mask-follows-node.md)', () => {
  const attach: Transform2D = { x: 10, y: 5, scaleX: 1, scaleY: 1, rotation: 0 };
  const consumerNow: Transform2D = {
    x: 90,
    y: 40,
    scaleX: 1.5,
    scaleY: 1.5,
    rotation: Math.PI / 6,
  };
  const delta = maskDisplayTransform(
    { space: 'node', attachTransform: attach },
    { transform2d: consumerNow, extent },
  );

  it('with an identity delta equals the plain vector-transform mapping', () => {
    const plain = vectorPointMaps(movedScaled, extent, maskDisplayTransform({}, { extent }));
    const p = { x: 33, y: 12 };
    expect(plain.toWorld(p)).toEqual(localToWorld(p, movedScaled, extent));
    expect(plain.toLocal(p)).toEqual(worldToLocal(p, movedScaled, extent));
  });

  it('a pointer position maps to stored path space and the anchor shows back under the pointer', () => {
    const { toWorld, toLocal } = vectorPointMaps(IDENTITY_TRANSFORM_2D, extent, delta);
    const pointer = { x: 120, y: 75 };
    const stored = toLocal(pointer);
    const back = toWorld(stored);
    expect(back.x).toBeCloseTo(pointer.x, 9);
    expect(back.y).toBeCloseTo(pointer.y, 9);
    // The stored point is NOT the pointer: the consumer has moved since attach.
    expect(Math.hypot(stored.x - pointer.x, stored.y - pointer.y)).toBeGreaterThan(10);
  });

  it('dragging an anchor writes document-space geometry: moveAnchor by a stored-space delta lands under the pointer', () => {
    const { toWorld, toLocal } = vectorPointMaps(IDENTITY_TRANSFORM_2D, extent, delta);
    const anchor = { point: { x: 40, y: 30 } };
    const startPointer = toWorld(anchor.point);
    const endPointer = { x: startPointer.x + 25, y: startPointer.y - 9 };
    // PathEditor's anchor drag: delta = toLocal(end) - toLocal(start), added to the stored anchor.
    const a = toLocal(startPointer);
    const b = toLocal(endPointer);
    const dragged = { x: anchor.point.x + (b.x - a.x), y: anchor.point.y + (b.y - a.y) };
    const shown = toWorld(dragged);
    expect(shown.x).toBeCloseTo(endPointer.x, 9);
    expect(shown.y).toBeCloseTo(endPointer.y, 9);
  });
});
