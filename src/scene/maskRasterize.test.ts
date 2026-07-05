import { describe, expect, it } from 'vitest';
import {
  applyMatrix,
  boxBlurMask,
  docToLocalMatrix,
  invertMask,
  localToDocMatrix,
} from './maskRasterize';
import { IDENTITY_TRANSFORM_2D } from './types';

// The canvas-side inverse check (docToLocalMatrix against transform2d.ts's
// localToWorld) lives in canvas/transform2d.test.ts — scene/ tests can't
// import canvas/ (depcruise). Here: known-value checks only.

describe('docToLocalMatrix', () => {
  it('identity transform maps document coords straight through', () => {
    const m = docToLocalMatrix(IDENTITY_TRANSFORM_2D, 100, 50);
    expect(applyMatrix(m, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(applyMatrix(m, 100, 50)).toEqual({ x: 100, y: 50 });
  });

  it('undoes a pure translation', () => {
    const m = docToLocalMatrix({ ...IDENTITY_TRANSFORM_2D, x: 30, y: -10 }, 100, 50);
    // The node's local origin sits at document (30, -10).
    expect(applyMatrix(m, 30, -10)).toEqual({ x: 0, y: 0 });
    expect(applyMatrix(m, 130, 40)).toEqual({ x: 100, y: 50 });
  });

  it('undoes scale about the node centre', () => {
    const m = docToLocalMatrix({ ...IDENTITY_TRANSFORM_2D, scaleX: 2, scaleY: 2 }, 100, 50);
    // Centre is invariant under scale-about-centre.
    expect(applyMatrix(m, 50, 25)).toEqual({ x: 50, y: 25 });
    // Document (150, 75) is 2x from centre -> local (100, 50).
    expect(applyMatrix(m, 150, 75)).toEqual({ x: 100, y: 50 });
  });

  it('undoes a 90° rotation about the node centre', () => {
    const m = docToLocalMatrix({ ...IDENTITY_TRANSFORM_2D, rotation: Math.PI / 2 }, 100, 50);
    // localToWorld maps local (100, 25) -> centre + R90·(50, 0) = (50, 75).
    const local = applyMatrix(m, 50, 75);
    expect(local.x).toBeCloseTo(100);
    expect(local.y).toBeCloseTo(25);
  });
});

describe('localToDocMatrix', () => {
  it('is the exact inverse of docToLocalMatrix for an arbitrary transform', () => {
    const t = { x: 37, y: -12, scaleX: 1.8, scaleY: 0.6, rotation: 0.7 };
    const fwd = localToDocMatrix(t, 100, 50);
    const inv = docToLocalMatrix(t, 100, 50);

    for (const p of [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 12.5, y: 43 },
    ]) {
      const roundTrip = applyMatrix(
        inv,
        applyMatrix(fwd, p.x, p.y).x,
        applyMatrix(fwd, p.x, p.y).y,
      );
      expect(roundTrip.x).toBeCloseTo(p.x);
      expect(roundTrip.y).toBeCloseTo(p.y);
    }
  });

  it('places a pure translation where the compositor paints it', () => {
    const m = localToDocMatrix({ ...IDENTITY_TRANSFORM_2D, x: 30, y: -10 }, 100, 50);
    expect(applyMatrix(m, 0, 0)).toEqual({ x: 30, y: -10 });
    expect(applyMatrix(m, 100, 50)).toEqual({ x: 130, y: 40 });
  });
});

describe('boxBlurMask', () => {
  it('radius below 1 is a no-op', () => {
    const data = Uint8Array.from([0, 255, 0, 0]);
    boxBlurMask(data, 4, 1, 0.4);
    expect(Array.from(data)).toEqual([0, 255, 0, 0]);
  });

  it('leaves a uniform plane uniform', () => {
    const data = new Uint8Array(16 * 16).fill(200);
    boxBlurMask(data, 16, 16, 3);
    expect(data.every((v) => v === 200)).toBe(true);
  });

  it('spreads a hard edge into a monotonic feathered ramp', () => {
    const width = 32;
    const height = 1;
    const data = new Uint8Array(width * height);
    data.fill(255, 0, 16); // left half on, right half off

    boxBlurMask(data, width, height, 4);

    // Values descend across the former edge, hitting both extremes away from it.
    for (let x = 1; x < width; x++) {
      expect(data[x]).toBeLessThanOrEqual(data[x - 1]);
    }
    expect(data[0]).toBe(255);
    expect(data[width - 1]).toBe(0);
    // The edge itself is now a mid-value, not a step.
    expect(data[15]).toBeLessThan(255);
    expect(data[16]).toBeGreaterThan(0);
  });

  it('blurs symmetrically around a centred spike', () => {
    const width = 17;
    const data = new Uint8Array(width);
    data[8] = 255;

    boxBlurMask(data, width, 1, 2);

    for (let d = 1; d <= 8; d++) {
      expect(data[8 - d]).toBe(data[8 + d]);
    }
    expect(data[8]).toBeGreaterThan(data[7]);
  });
});

describe('invertMask', () => {
  it('flips every value to 255 - v', () => {
    const data = Uint8Array.from([0, 64, 255]);
    invertMask(data);
    expect(Array.from(data)).toEqual([255, 191, 0]);
  });
});
