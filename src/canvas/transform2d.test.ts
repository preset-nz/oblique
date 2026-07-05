import { describe, expect, it } from 'vitest';
import { applyMatrix, docToLocalMatrix } from '@/scene/maskRasterize';
import { IDENTITY_TRANSFORM_2D, type Transform2D } from '@/scene/types';
import {
  applyMove,
  applyRotate,
  applyScale,
  boundsCorners,
  handlePositions,
  hitTestNode,
  localToWorld,
  worldToLocal,
} from './transform2d';

const EXTENT = { w: 200, h: 100 };

describe('localToWorld / worldToLocal — inverse of each other', () => {
  it('identity transform: local == world (no offset)', () => {
    expect(localToWorld({ x: 0, y: 0 }, IDENTITY_TRANSFORM_2D, EXTENT)).toEqual({ x: 0, y: 0 });
    expect(localToWorld({ x: 200, y: 100 }, IDENTITY_TRANSFORM_2D, EXTENT)).toEqual({
      x: 200,
      y: 100,
    });
  });

  it('translate-only: local origin lands at (x, y)', () => {
    const t = { ...IDENTITY_TRANSFORM_2D, x: 30, y: 10 };
    expect(localToWorld({ x: 0, y: 0 }, t, EXTENT)).toEqual({ x: 30, y: 10 });
  });

  it('worldToLocal inverts localToWorld for a rotated + scaled + translated transform', () => {
    const t = { x: 40, y: 20, scaleX: 2, scaleY: 0.5, rotation: Math.PI / 6 };
    const localPoints = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
      { x: 73, y: 41 },
    ];
    for (const local of localPoints) {
      const world = localToWorld(local, t, EXTENT);
      const roundTripped = worldToLocal(world, t, EXTENT);
      expect(roundTripped.x).toBeCloseTo(local.x, 6);
      expect(roundTripped.y).toBeCloseTo(local.y, 6);
    }
  });
});

describe('hitTestNode', () => {
  it('identity transform: hits inside sourceSize bounds, misses outside', () => {
    expect(hitTestNode({ x: 100, y: 50 }, IDENTITY_TRANSFORM_2D, EXTENT)).toBe(true);
    expect(hitTestNode({ x: -1, y: 50 }, IDENTITY_TRANSFORM_2D, EXTENT)).toBe(false);
    expect(hitTestNode({ x: 201, y: 50 }, IDENTITY_TRANSFORM_2D, EXTENT)).toBe(false);
  });

  it('translated node: bounds follow the translation', () => {
    const t = { ...IDENTITY_TRANSFORM_2D, x: 500, y: 500 };
    expect(hitTestNode({ x: 100, y: 50 }, t, EXTENT)).toBe(false);
    expect(hitTestNode({ x: 600, y: 550 }, t, EXTENT)).toBe(true);
  });

  it('rotated 90 degrees: a point on the (now-vertical) long edge still hits', () => {
    const t = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: Math.PI / 2 };
    // centre stays at (100, 50) in document space regardless of rotation.
    // A point that was on the local right edge (200, 50) rotates to (100, 150).
    expect(hitTestNode({ x: 100, y: 150 }, t, EXTENT)).toBe(true);
    // A point outside all rotations of the bounds.
    expect(hitTestNode({ x: 0, y: 0 }, t, EXTENT)).toBe(false);
  });

  it('scaled 2x: a point that would miss the un-scaled bounds now hits', () => {
    const t = { x: 0, y: 0, scaleX: 2, scaleY: 2, rotation: 0 };
    // Centre (100,50); scaled 2x means the box spans doc x in [-100, 300].
    expect(hitTestNode({ x: -50, y: 50 }, t, EXTENT)).toBe(true);
    expect(hitTestNode({ x: -150, y: 50 }, t, EXTENT)).toBe(false);
  });
});

describe('applyMove', () => {
  it('adds the doc-space pointer delta to x/y, leaving scale/rotation untouched', () => {
    const start = { x: 10, y: 20, scaleX: 1.5, scaleY: 0.5, rotation: 1.2 };
    const next = applyMove(start, { x: 5, y: -3 });
    expect(next).toEqual({ x: 15, y: 17, scaleX: 1.5, scaleY: 0.5, rotation: 1.2 });
  });
});

describe('applyRotate', () => {
  it('rotates by exactly the pointer angle delta from drag-start', () => {
    const start = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    // Pointer directly above centre at drag-start, directly right of centre at drag-end: 90 degree turn.
    const centre = { x: 100, y: 50 };
    const above = { x: centre.x, y: centre.y - 50 };
    const right = { x: centre.x + 50, y: centre.y };
    const next = applyRotate(start, EXTENT, right, above, false);
    expect(next.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it('snaps to the nearest 15 degrees when snap is true', () => {
    const start = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    const centre = { x: 100, y: 50 };
    const above = { x: centre.x, y: centre.y - 50 };
    // ~10 degrees off vertical -> should snap to 15 degrees, not 10.
    const angle = (10 * Math.PI) / 180;
    const nearlyTen = {
      x: centre.x + 50 * Math.sin(angle),
      y: centre.y - 50 * Math.cos(angle),
    };
    const next = applyRotate(start, EXTENT, nearlyTen, above, true);
    expect(next.rotation).toBeCloseTo((15 * Math.PI) / 180, 6);
  });
});

describe('applyScale', () => {
  it('dragging the se corner handle out to 2x the half-extent doubles scaleX/scaleY', () => {
    const start = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    // se corner starts at world (200, 100); drag it to (300, 150) — 2x the
    // half-extent (100, 50) from centre (100, 50).
    const next = applyScale(start, EXTENT, 'se', { x: 300, y: 150 }, false);
    expect(next.scaleX).toBeCloseTo(2, 6);
    expect(next.scaleY).toBeCloseTo(2, 6);
  });

  it('an edge handle (e) only changes its own axis', () => {
    const start = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    const next = applyScale(start, EXTENT, 'e', { x: 300, y: 999 }, false);
    expect(next.scaleX).toBeCloseTo(2, 6);
    expect(next.scaleY).toBe(1); // untouched
  });

  it('dragging past the centre to the opposite side flips the sign (mirrors the node)', () => {
    const start = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    const next = applyScale(start, EXTENT, 'se', { x: 0, y: 100 }, false);
    expect(next.scaleX).toBeLessThan(0);
  });

  it('snap locks both axes to the larger magnitude, preserving each sign', () => {
    const start = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    // Drag se to (400, 150): scaleX would be 3, scaleY would be 2 without snap.
    const next = applyScale(start, EXTENT, 'se', { x: 400, y: 150 }, true);
    expect(next.scaleX).toBeCloseTo(3, 6);
    expect(next.scaleY).toBeCloseTo(3, 6);
  });

  it('never returns a zero-magnitude scale (degenerate node)', () => {
    const start = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    // Drag the se handle exactly onto the centre.
    const next = applyScale(start, EXTENT, 'se', { x: 100, y: 50 }, false);
    expect(Math.abs(next.scaleX)).toBeGreaterThan(0);
    expect(Math.abs(next.scaleY)).toBeGreaterThan(0);
  });
});

describe('handlePositions / boundsCorners — identity transform matches the un-transformed rect', () => {
  it('corners sit exactly on the node bounds', () => {
    const corners = boundsCorners(IDENTITY_TRANSFORM_2D, EXTENT);
    expect(corners).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ]);
  });

  it('the rotate handle sits above top-centre', () => {
    const handles = handlePositions(IDENTITY_TRANSFORM_2D, EXTENT);
    expect(handles.rotate.x).toBeCloseTo(100, 6);
    expect(handles.rotate.y).toBeLessThan(0);
  });

  it('the se handle sits at the bottom-right corner', () => {
    const handles = handlePositions(IDENTITY_TRANSFORM_2D, EXTENT);
    expect(handles.se).toEqual({ x: 200, y: 100 });
  });
});

describe('scene/maskRasterize.ts docToLocalMatrix inverts localToWorld', () => {
  // scene/ reimplements the inverse as a flat matrix (it must not import
  // canvas/); this cross-check is what keeps the two implementations
  // honest with each other (see maskRasterize.ts's module doc).
  it('round-trips arbitrary points through localToWorld then the inverse matrix', () => {
    const t: Transform2D = { x: 37, y: -12, scaleX: 1.7, scaleY: 0.6, rotation: 0.83 };
    const extent = { w: 320, h: 180 };
    const m = docToLocalMatrix(t, extent.w, extent.h);

    for (const local of [
      { x: 0, y: 0 },
      { x: 320, y: 180 },
      { x: 160, y: 90 },
      { x: 12.5, y: 173.2 },
    ]) {
      const world = localToWorld(local, t, extent);
      const back = applyMatrix(m, world.x, world.y);
      expect(back.x).toBeCloseTo(local.x, 6);
      expect(back.y).toBeCloseTo(local.y, 6);
    }
  });
});
