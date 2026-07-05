import { describe, expect, it } from 'vitest';
import { type Cubic, closestPointOnCubic, cubicPointAt, lineCubic, splitCubicAt } from './bezier';

describe('cubicPointAt', () => {
  it('degenerate straight-line cubic: point at any t lies exactly on the line', () => {
    const cubic = lineCubic({ x: 0, y: 0 }, { x: 100, y: 0 });
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = cubicPointAt(cubic, t);
      expect(p.x).toBeCloseTo(100 * t, 9);
      expect(p.y).toBeCloseTo(0, 9);
    }
  });

  it('symmetric curve: midpoint at t=0.5 lands on the curve axis of symmetry', () => {
    // A cubic symmetric about x=50 (p0/p1 and c1/c2 mirrored around x=50).
    const cubic: Cubic = {
      p0: { x: 0, y: 0 },
      c1: { x: 20, y: 100 },
      c2: { x: 80, y: 100 },
      p1: { x: 100, y: 0 },
    };
    const mid = cubicPointAt(cubic, 0.5);
    expect(mid.x).toBeCloseTo(50, 9);
  });

  it('endpoints at t=0 and t=1', () => {
    const cubic: Cubic = {
      p0: { x: 1, y: 2 },
      c1: { x: 3, y: 4 },
      c2: { x: 5, y: 6 },
      p1: { x: 7, y: 8 },
    };
    expect(cubicPointAt(cubic, 0)).toEqual(cubic.p0);
    expect(cubicPointAt(cubic, 1)).toEqual(cubic.p1);
  });
});

describe('splitCubicAt', () => {
  it('preserves shape: sampled points on both halves match the original curve', () => {
    const cubic: Cubic = {
      p0: { x: 0, y: 0 },
      c1: { x: 30, y: 90 },
      c2: { x: 70, y: -40 },
      p1: { x: 100, y: 20 },
    };
    const splitT = 0.4;
    const { left, right } = splitCubicAt(cubic, splitT);

    // Sample the left half at local t and compare to the original at
    // t * splitT; same for the right half at splitT + t * (1 - splitT).
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const leftPoint = cubicPointAt(left, t);
      const originalAtScaled = cubicPointAt(cubic, t * splitT);
      expect(leftPoint.x).toBeCloseTo(originalAtScaled.x, 9);
      expect(leftPoint.y).toBeCloseTo(originalAtScaled.y, 9);

      const rightPoint = cubicPointAt(right, t);
      const originalAtScaledRight = cubicPointAt(cubic, splitT + t * (1 - splitT));
      expect(rightPoint.x).toBeCloseTo(originalAtScaledRight.x, 9);
      expect(rightPoint.y).toBeCloseTo(originalAtScaledRight.y, 9);
    }

    // The join point matches the original curve at the split parameter.
    const joinExpected = cubicPointAt(cubic, splitT);
    expect(left.p1.x).toBeCloseTo(joinExpected.x, 9);
    expect(left.p1.y).toBeCloseTo(joinExpected.y, 9);
    expect(right.p0.x).toBeCloseTo(joinExpected.x, 9);
    expect(right.p0.y).toBeCloseTo(joinExpected.y, 9);
  });
});

describe('closestPointOnCubic', () => {
  it('projects onto a straight line exactly (perpendicular foot)', () => {
    const cubic = lineCubic({ x: 0, y: 0 }, { x: 100, y: 0 });
    const result = closestPointOnCubic(cubic, { x: 40, y: 10 });
    expect(result.t).toBeCloseTo(0.4, 3);
    expect(result.point.x).toBeCloseTo(40, 2);
    expect(result.point.y).toBeCloseTo(0, 2);
    expect(result.distance).toBeCloseTo(10, 2);
  });

  it('projection error stays under 0.5 doc px on a curved segment', () => {
    const cubic: Cubic = {
      p0: { x: 0, y: 0 },
      c1: { x: 30, y: 90 },
      c2: { x: 70, y: -40 },
      p1: { x: 100, y: 20 },
    };
    // A point ON the curve at a known t: the projection must find (close to)
    // that same t and land within 0.5px of the true point.
    const trueT = 0.63;
    const truePoint = cubicPointAt(cubic, trueT);
    const result = closestPointOnCubic(cubic, truePoint);
    expect(result.distance).toBeLessThan(0.5);
  });

  it('a point off the curve projects within 0.5 doc px of the true closest point', () => {
    const cubic: Cubic = {
      p0: { x: 0, y: 0 },
      c1: { x: 0, y: 100 },
      c2: { x: 100, y: 100 },
      p1: { x: 100, y: 0 },
    };
    // Dense-sample the curve ourselves to find a reference closest point,
    // then check the function's result isn't meaningfully worse.
    const query = { x: 50, y: 120 };
    let refBest = Infinity;
    for (let i = 0; i <= 2000; i++) {
      const t = i / 2000;
      const p = cubicPointAt(cubic, t);
      const d = Math.hypot(p.x - query.x, p.y - query.y);
      if (d < refBest) refBest = d;
    }
    const result = closestPointOnCubic(cubic, query);
    expect(Math.abs(result.distance - refBest)).toBeLessThan(0.5);
  });
});
