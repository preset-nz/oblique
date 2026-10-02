import { describe, expect, it } from 'vitest';
import { applyMatrix, docToLocalMatrix, localToDocMatrix } from './maskRasterize';
import { fitReplacedTransform, refitAttachTransform } from './sourceFit';
import type { Transform2D } from './types';

function centre(t: Transform2D, w: number, h: number) {
  // The compositor rotates/scales about the box centre, so that point is fixed by the placement.
  return applyMatrix(localToDocMatrix(t, w, h), w / 2, h / 2);
}

describe('fitReplacedTransform', () => {
  it('512x512 -> 4000x2000: the box stays 512 wide and becomes 256 tall, centred where it was', () => {
    const old: Transform2D = { x: 100, y: 40, scaleX: 1, scaleY: 1, rotation: 0 };
    const next = fitReplacedTransform(old, [512, 512], [4000, 2000]);
    expect(4000 * Math.abs(next.scaleX)).toBeCloseTo(512, 9);
    expect(2000 * Math.abs(next.scaleY)).toBeCloseTo(256, 9);
    const before = centre(old, 512, 512);
    const after = centre(next, 4000, 2000);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('an absent transform is the identity', () => {
    const next = fitReplacedTransform(undefined, [100, 100], [50, 25]);
    expect(next.scaleX).toBeCloseTo(2, 9);
    expect(next.scaleY).toBeCloseTo(2, 9);
    expect(centre(next, 50, 25)).toEqual({ x: 50, y: 50 });
  });

  it('a rotated, h-flipped, moved, non-uniformly scaled node keeps its centre, rotation and flip, and fits the old box', () => {
    const old: Transform2D = { x: -37, y: 211, scaleX: -1.5, scaleY: 0.75, rotation: 0.6 };
    const [w0, h0] = [640, 480];
    const [w1, h1] = [300, 900];
    const next = fitReplacedTransform(old, [w0, h0], [w1, h1]);

    expect(next.rotation).toBe(old.rotation);
    expect(Math.sign(next.scaleX)).toBe(-1);
    expect(Math.sign(next.scaleY)).toBe(1);
    expect(Math.abs(next.scaleX)).toBeCloseTo(Math.abs(next.scaleY), 9); // uniform fit

    const c0 = centre(old, w0, h0);
    const c1 = centre(next, w1, h1);
    expect(c1.x).toBeCloseTo(c0.x, 9);
    expect(c1.y).toBeCloseTo(c0.y, 9);

    // The new image's corners, mapped into the OLD node's local frame, sit
    // inside the old box and touch it on at least one axis.
    const toOldLocal = docToLocalMatrix(old, w0, h0);
    const toDoc = localToDocMatrix(next, w1, h1);
    const corners = [
      [0, 0],
      [w1, 0],
      [w1, h1],
      [0, h1],
    ].map(([x, y]) => {
      const d = applyMatrix(toDoc, x, y);
      return applyMatrix(toOldLocal, d.x, d.y);
    });
    for (const p of corners) {
      expect(p.x).toBeGreaterThan(-1e-6);
      expect(p.x).toBeLessThan(w0 + 1e-6);
      expect(p.y).toBeGreaterThan(-1e-6);
      expect(p.y).toBeLessThan(h0 + 1e-6);
    }
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const touchesX = Math.min(...xs) < 1e-6 && Math.max(...xs) > w0 - 1e-6;
    const touchesY = Math.min(...ys) < 1e-6 && Math.max(...ys) > h0 - 1e-6;
    expect(touchesX || touchesY).toBe(true);
  });

  it('a collapsed old footprint keeps its scale and still preserves the centre', () => {
    const old: Transform2D = { x: 10, y: 10, scaleX: 0, scaleY: 1, rotation: 0 };
    const next = fitReplacedTransform(old, [100, 100], [40, 40]);
    expect(next.scaleX).toBe(0);
    expect(next.scaleY).toBe(1);
    expect(next.x + 20).toBeCloseTo(10 + 50, 9);
  });
});

describe('refitAttachTransform', () => {
  it('a node-space mask covers the same canvas region after the node is replaced', () => {
    const old: Transform2D = { x: 50, y: -20, scaleX: -1.25, scaleY: 0.8, rotation: 0.4 };
    // Snapshot taken earlier, before the node was moved/scaled.
    const attach: Transform2D = { x: 10, y: 30, scaleX: 1, scaleY: 1, rotation: 0.1 };
    const [w0, h0] = [800, 600];
    const [w1, h1] = [1200, 500];
    const next = fitReplacedTransform(old, [w0, h0], [w1, h1]);
    const attach1 = refitAttachTransform(attach, old, next, [w0, h0], [w1, h1]);

    for (const [px, py] of [
      [0, 0],
      [123, 456],
      [-50, 700],
      [900, 90],
    ]) {
      // Where a shape point (document space) is composited: into the mask
      // buffer via the snapshot, then out through the node's placement.
      const l0 = applyMatrix(docToLocalMatrix(attach, w0, h0), px, py);
      const before = applyMatrix(localToDocMatrix(old, w0, h0), l0.x, l0.y);
      const l1 = applyMatrix(docToLocalMatrix(attach1, w1, h1), px, py);
      const after = applyMatrix(localToDocMatrix(next, w1, h1), l1.x, l1.y);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('WITHOUT the refit the mask would have moved (the finding the store action exists for)', () => {
    const old: Transform2D = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    const attach: Transform2D = { ...old };
    const [w0, h0] = [800, 600];
    const [w1, h1] = [1200, 500];
    const next = fitReplacedTransform(old, [w0, h0], [w1, h1]);
    const p = { x: 100, y: 100 };
    const local0 = applyMatrix(docToLocalMatrix(attach, w0, h0), p.x, p.y);
    const before = applyMatrix(localToDocMatrix(old, w0, h0), local0.x, local0.y);
    const local1 = applyMatrix(docToLocalMatrix(attach, w1, h1), p.x, p.y);
    const after = applyMatrix(localToDocMatrix(next, w1, h1), local1.x, local1.y);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1);
  });
});
