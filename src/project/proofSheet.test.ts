import { describe, expect, it, vi } from 'vitest';
import {
  defaultProofMargin,
  markBounds,
  overlaps,
  type ProofBarEdge,
  type ProofContext,
  type ProofOptions,
  paintProof,
  patchColour,
  proofLayout,
  tintSteps,
} from './proofSheet';

const base: ProofOptions = {
  margin: 40,
  paper: 'white',
  marks: true,
  edgeMarks: false,
  bars: true,
  steps: 5,
  barEdge: 'bottom',
};

function fakeCtx() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
}

describe('defaultProofMargin', () => {
  it('is 8% of the short edge, rounded', () => {
    expect(defaultProofMargin(1000, 600)).toBe(48);
    expect(defaultProofMargin(333, 900)).toBe(27);
  });
});

describe('tintSteps / patchColour', () => {
  it('spaces tints evenly from 100% down to 100/steps %', () => {
    expect(tintSteps(5)).toEqual([1, 0.8, 0.6, 0.4, 0.2].map((v) => expect.closeTo(v, 10)));
    expect(tintSteps(3)).toEqual([1, 2 / 3, 1 / 3].map((v) => expect.closeTo(v, 10)));
  });

  it('uses the screen approximation per ink', () => {
    expect(patchColour('c', 1)).toBe('rgb(0, 255, 255)');
    expect(patchColour('m', 1)).toBe('rgb(255, 0, 255)');
    expect(patchColour('y', 1)).toBe('rgb(255, 255, 0)');
    expect(patchColour('k', 1)).toBe('rgb(0, 0, 0)');
    expect(patchColour('grey', 0.5)).toBe('rgb(128, 128, 128)');
  });
});

describe('proofLayout', () => {
  it('is the document plus 2×margin on each axis, work at (margin, margin)', () => {
    const l = proofLayout(300, 200, base);
    expect(l.width).toBe(380);
    expect(l.height).toBe(280);
    expect(l.work).toEqual({ x: 40, y: 40, w: 300, h: 200 });
  });

  it('lays out C, M, Y, K runs then a grey patch', () => {
    const l = proofLayout(2000, 1000, { ...base, steps: 3 });
    expect(l.patches.map((p) => p.ink)).toEqual([
      ...Array(3).fill('c'),
      ...Array(3).fill('m'),
      ...Array(3).fill('y'),
      ...Array(3).fill('k'),
      'grey',
    ]);
    expect(l.patches[0].tint).toBe(1);
    expect(l.patches[0].w).toBe(20); // margin × 0.5
    expect(l.patches[0].h).toBe(20);
  });

  it('puts four corner marks, plus edge centres when asked, with the spec radius and stroke', () => {
    const corners = proofLayout(2000, 1000, { ...base, margin: 120, bars: false });
    expect(corners.marks).toHaveLength(4);
    expect(corners.marks[0]).toMatchObject({ cx: 60, cy: 60, r: 30, lineWidth: 1 });
    const edges = proofLayout(2000, 1000, { ...base, margin: 120, bars: false, edgeMarks: true });
    expect(edges.marks).toHaveLength(8);
  });

  it('draws no marks or patches when switched off', () => {
    const l = proofLayout(300, 200, { ...base, marks: false, bars: false });
    expect(l.marks).toEqual([]);
    expect(l.patches).toEqual([]);
  });

  it('drops the edge-centre mark that would sit on the colour bar', () => {
    const l = proofLayout(2000, 1000, { ...base, edgeMarks: true, barEdge: 'bottom' });
    expect(l.marks).toHaveLength(7);
    expect(l.marks.some((m) => m.cy === l.height - 20 && m.cx === l.width / 2)).toBe(false);
  });

  it('shrinks the patches to fit when the strip would be longer than the edge', () => {
    const l = proofLayout(200, 200, { ...base, margin: 40, steps: 7 }); // 29 patches
    expect(l.patches).toHaveLength(29);
    const side = l.patches[0].w;
    expect(side).toBeLessThan(20);
    expect(l.patches[28].x + side).toBeLessThanOrEqual(40 + 200);
  });

  const edges: ProofBarEdge[] = ['bottom', 'right'];
  for (const steps of [3, 5, 7] as const) {
    for (const barEdge of edges) {
      for (const edgeMarks of [false, true]) {
        for (const [w, h, margin] of [
          [600, 400, 32],
          [1200, 300, 96],
          [100, 80, 8],
          [4000, 3000, 240],
        ]) {
          it(`keeps every mark and patch out of the work area (${steps} steps, ${barEdge}, edge marks ${edgeMarks}, ${w}×${h} m${margin})`, () => {
            const l = proofLayout(w, h, { ...base, margin, steps, barEdge, edgeMarks });
            expect(l.marks.length).toBeGreaterThan(0);
            for (const m of l.marks) {
              expect(overlaps(markBounds(m), l.work)).toBe(false);
              const b = markBounds(m); // and inside the sheet
              expect(b.x).toBeGreaterThanOrEqual(-1e-9);
              expect(b.y).toBeGreaterThanOrEqual(-1e-9);
              expect(b.x + b.w).toBeLessThanOrEqual(l.width + 1e-9);
              expect(b.y + b.h).toBeLessThanOrEqual(l.height + 1e-9);
            }
            expect(l.patches).toHaveLength(4 * steps + 1);
            for (const p of l.patches) {
              expect(overlaps(p, l.work)).toBe(false);
              expect(p.x).toBeGreaterThanOrEqual(0);
              expect(p.y).toBeGreaterThanOrEqual(0);
              expect(p.x + p.w).toBeLessThanOrEqual(l.width);
              expect(p.y + p.h).toBeLessThanOrEqual(l.height);
            }
          });
        }
      }
    }
  }
});

describe('paintProof', () => {
  const work = {} as CanvasImageSource;

  it('draws the work once, at (margin, margin), at native size — no size arguments', () => {
    const ctx = fakeCtx();
    const layout = proofLayout(300, 200, base);
    paintProof(ctx as unknown as ProofContext, work, layout, base);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(work, 40, 40);
  });

  it('fills white paper in the margin only, never over the work rect', () => {
    const ctx = fakeCtx();
    const layout = proofLayout(300, 200, { ...base, marks: false, bars: false });
    paintProof(ctx as unknown as ProofContext, work, layout, {
      ...base,
      marks: false,
      bars: false,
    });
    const rects = ctx.fillRect.mock.calls.map(([x, y, w, h]) => ({ x, y, w, h }));
    expect(rects).toHaveLength(4);
    for (const r of rects) expect(overlaps(r, layout.work)).toBe(false);
    const area = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBe(layout.width * layout.height - 300 * 200);
  });

  it('with transparent paper, nothing fills the margin except the patches', () => {
    const ctx = fakeCtx();
    const opts: ProofOptions = { ...base, paper: 'transparent' };
    const layout = proofLayout(300, 200, opts);
    paintProof(ctx as unknown as ProofContext, work, layout, opts);
    expect(ctx.fillRect).toHaveBeenCalledTimes(layout.patches.length);
    const noBars: ProofOptions = { ...opts, bars: false };
    const ctx2 = fakeCtx();
    paintProof(ctx2 as unknown as ProofContext, work, proofLayout(300, 200, noBars), noBars);
    expect(ctx2.fillRect).not.toHaveBeenCalled();
  });

  it('strokes each mark in registration black', () => {
    const ctx = fakeCtx();
    const layout = proofLayout(300, 200, { ...base, bars: false });
    paintProof(ctx as unknown as ProofContext, work, layout, { ...base, bars: false });
    expect(ctx.strokeStyle).toBe('#000');
    expect(ctx.arc).toHaveBeenCalledTimes(4);
    expect(ctx.stroke).toHaveBeenCalledTimes(4);
  });
});
