import { describe, expect, it } from 'vitest';
import { SNAP_SCREEN_PX, snapAxis, snapMove, snapToleranceDoc } from './snap';

describe('snapAxis', () => {
  it('returns null when nothing is within tolerance', () => {
    expect(snapAxis([0, 10], [50, 100], 6)).toBeNull();
    expect(snapAxis([], [50], 6)).toBeNull();
    expect(snapAxis([5], [], 6)).toBeNull();
  });

  it('snaps within tolerance, inclusive of the boundary', () => {
    expect(snapAxis([97], [100], 6)).toEqual({ delta: 3, at: 100 });
    expect(snapAxis([94], [100], 6)).toEqual({ delta: 6, at: 100 });
    expect(snapAxis([93.9], [100], 6)).toBeNull();
  });

  it('picks the nearest pair across all candidates and targets', () => {
    // candidates 0/50/100 vs targets 4, 52, 110: best is 50->52 (delta 2)
    expect(snapAxis([0, 50, 100], [4, 52, 110], 6)).toEqual({ delta: 2, at: 52 });
  });

  it('handles negative deltas', () => {
    expect(snapAxis([103], [100], 6)).toEqual({ delta: -3, at: 100 });
  });

  it('on an exact |delta| tie keeps the first pair (candidate order, then target order)', () => {
    expect(snapAxis([100], [97, 103], 6)).toEqual({ delta: -3, at: 97 });
    expect(snapAxis([100], [103, 97], 6)).toEqual({ delta: 3, at: 103 });
  });

  it('a smaller |delta| beats an earlier larger one', () => {
    expect(snapAxis([100], [95, 102], 6)).toEqual({ delta: 2, at: 102 });
  });
});

describe('snapMove', () => {
  const targets = { xs: [0, 100, 200], ys: [0, 100, 200] };

  it('centres on the document centre and reports the guide', () => {
    // 60x40 box centred at x=103 -> cx 103 (delta -3 to 100); y far from any line
    const r = snapMove({ x: 73, y: 20, w: 60, h: 40 }, targets, 6);
    expect(r.dx).toBe(-3);
    expect(r.guideX).toBe(100);
  });

  it('snaps an edge as well as a centre', () => {
    // left edge at 4 -> 0
    const r = snapMove({ x: 4, y: 30, w: 20, h: 20 }, targets, 6);
    expect(r).toMatchObject({ dx: -4, guideX: 0 });
  });

  it('keeps the axes independent: x snaps, y does not', () => {
    const r = snapMove({ x: 98, y: 40, w: 4, h: 10 }, targets, 6);
    expect(r.dx).toBe(0); // centre 100 already on target
    expect(r.guideX).toBe(100);
    expect(r.dy).toBe(0);
    expect(r.guideY).toBeUndefined();
  });

  it('keeps the axes independent: y snaps, x does not', () => {
    const r = snapMove({ x: 30, y: 96, w: 10, h: 10 }, targets, 6);
    expect(r.guideX).toBeUndefined();
    expect(r.dx).toBe(0);
    expect(r.guideY).toBe(100);
    expect(r.dy).toBe(-1);
  });

  it('returns a zero offset and no guides when nothing is in range', () => {
    const r = snapMove({ x: 30, y: 30, w: 10, h: 10 }, targets, 6);
    expect(r).toEqual({ dx: 0, dy: 0 });
  });
});

describe('snapToleranceDoc', () => {
  it('is 6 screen px at 100%', () => {
    expect(snapToleranceDoc(1)).toBe(SNAP_SCREEN_PX);
  });

  it('stays 6 SCREEN px at 25% and 400% zoom', () => {
    const at25 = snapToleranceDoc(0.25);
    const at400 = snapToleranceDoc(4);
    expect(at25).toBe(24); // 24 doc px * 0.25 = 6 screen px
    expect(at400).toBe(1.5); // 1.5 doc px * 4 = 6 screen px
    expect(at25 * 0.25).toBe(SNAP_SCREEN_PX);
    expect(at400 * 4).toBe(SNAP_SCREEN_PX);
  });

  it('through snapAxis: a 10 doc px gap snaps at 25% (2.5 screen px) but not at 400% (40 screen px)', () => {
    expect(snapAxis([90], [100], snapToleranceDoc(0.25))).not.toBeNull();
    expect(snapAxis([90], [100], snapToleranceDoc(4))).toBeNull();
  });

  it('survives a degenerate scale', () => {
    expect(Number.isFinite(snapToleranceDoc(0))).toBe(true);
  });
});
