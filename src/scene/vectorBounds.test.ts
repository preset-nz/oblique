import { describe, expect, it } from 'vitest';
import type { VectorPath } from './types';
import { vectorContentBounds } from './vectorBounds';

function corner(x: number, y: number) {
  return { point: { x, y } };
}

describe('vectorContentBounds', () => {
  it('returns null for no paths / no anchors', () => {
    expect(vectorContentBounds([])).toBeNull();
    expect(vectorContentBounds([{ anchors: [], closed: false }])).toBeNull();
  });

  it('straight-line polygon: bbox of the corner points', () => {
    const paths: VectorPath[] = [
      { anchors: [corner(10, 20), corner(50, 20), corner(30, 60)], closed: true },
    ];
    expect(vectorContentBounds(paths)).toEqual({ x: 10, y: 20, w: 40, h: 40 });
  });

  it('open path: no wrap-around segment, bbox still covers all anchors', () => {
    const paths: VectorPath[] = [{ anchors: [corner(0, 0), corner(10, 5)], closed: false }];
    expect(vectorContentBounds(paths)).toEqual({ x: 0, y: 0, w: 10, h: 5 });
  });

  it('curve extrema: a bulging segment extends the box past its endpoints, but not to the control-point hull', () => {
    // Horizontal segment (0,0)→(30,0) with both handles pulled to y=-30:
    // the curve's topmost point is y = -22.5 (t=0.5), NOT -30 (hull).
    const paths: VectorPath[] = [
      {
        anchors: [
          { point: { x: 0, y: 0 }, handleOut: { x: 10, y: -30 } },
          { point: { x: 30, y: 0 }, handleIn: { x: 20, y: -30 } },
        ],
        closed: false,
      },
    ];
    const b = vectorContentBounds(paths);
    expect(b).not.toBeNull();
    expect(b?.y).toBeCloseTo(-22.5, 5);
    expect(b?.h).toBeCloseTo(22.5, 5);
    expect(b?.x).toBe(0);
    expect(b?.w).toBe(30);
  });

  it('multiple paths union into one box', () => {
    const paths: VectorPath[] = [
      { anchors: [corner(0, 0), corner(10, 10)], closed: false },
      { anchors: [corner(90, 90), corner(100, 100)], closed: false },
    ];
    expect(vectorContentBounds(paths)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('closed wrap-around segment with handles counts toward the box', () => {
    // Two anchors; the closing segment bulges right via its handles.
    const paths: VectorPath[] = [
      {
        anchors: [
          { point: { x: 0, y: 0 }, handleIn: { x: 40, y: 0 } },
          { point: { x: 0, y: 30 }, handleOut: { x: 40, y: 30 } },
        ],
        closed: true,
      },
    ];
    const b = vectorContentBounds(paths);
    expect(b).not.toBeNull();
    // Forward segment (0,0)→(0,30) is straight (no handleOut/handleIn on
    // that side); the wrap segment (0,30)→(0,0) uses handleOut/handleIn at
    // x=40 → curve max x = 30 (t=0.5), inside the hull's 40.
    expect(b?.x).toBe(0);
    expect(b?.w).toBeCloseTo(30, 5);
  });
});
