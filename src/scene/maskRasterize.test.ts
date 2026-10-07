import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMatrix,
  boxBlurMask,
  docToLocalMatrix,
  invertMask,
  localToDocMatrix,
  rasterizeVectorMask,
} from './maskRasterize';
import { IDENTITY_TRANSFORM_2D, type Transform2D, type VectorPath } from './types';

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

// rasterizeVectorMask needs OffscreenCanvas/Path2D, which vitest's node
// environment lacks. A minimal software stand-in: Path2D records polygon
// vertices; the 2d context tracks the current matrix exactly as the real
// one composes it (setTransform replaces, transform appends right) and
// `fill` scan-converts the matrix-mapped polygon at pixel centres. Enough to
// exercise WHICH consumer frame the rasteriser inverts — the actual change.
describe('rasterizeVectorMask — node-pinned frame (mask-follows-node.md)', () => {
  type M = [number, number, number, number, number, number];

  class FakePath2D {
    points: { x: number; y: number }[] = [];
    moveTo(x: number, y: number) {
      this.points.push({ x, y });
    }
    lineTo(x: number, y: number) {
      this.points.push({ x, y });
    }
    bezierCurveTo(_a: number, _b: number, _c: number, _d: number, x: number, y: number) {
      this.points.push({ x, y });
    }
    closePath() {}
  }

  const mul = (m: M, n: M): M => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];

  class FakeContext {
    matrix: M = [1, 0, 0, 1, 0, 0];
    data: Uint8ClampedArray;
    fillStyle = '';
    lineWidth = 0;
    lineJoin = '';
    lineCap = '';
    strokeStyle = '';
    globalCompositeOperation = 'source-over';
    constructor(
      private w: number,
      private h: number,
    ) {
      this.data = new Uint8ClampedArray(w * h * 4);
    }
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      this.matrix = [a, b, c, d, e, f];
    }
    transform(a: number, b: number, c: number, d: number, e: number, f: number) {
      this.matrix = mul(this.matrix, [a, b, c, d, e, f]);
    }
    fill(path: FakePath2D) {
      const m = this.matrix;
      const poly = path.points.map((p) => ({
        x: m[0] * p.x + m[2] * p.y + m[4],
        y: m[1] * p.x + m[3] * p.y + m[5],
      }));
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          let inside = false;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i];
            const b = poly[j];
            if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
              inside = !inside;
            }
          }
          if (inside) this.data[(y * this.w + x) * 4 + 3] = 255;
        }
      }
    }
    stroke() {}
    getImageData() {
      return { data: this.data };
    }
  }

  class FakeOffscreenCanvas {
    private ctx: FakeContext;
    constructor(w: number, h: number) {
      this.ctx = new FakeContext(w, h);
    }
    getContext() {
      return this.ctx;
    }
  }

  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('Path2D', FakePath2D);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A square well inside a 100x80 consumer, in document space.
  const paths: VectorPath[] = [
    {
      closed: true,
      anchors: [
        { point: { x: 20, y: 15 } },
        { point: { x: 60, y: 15 } },
        { point: { x: 60, y: 50 } },
        { point: { x: 20, y: 50 } },
      ],
    },
  ];
  const ref = { featherPx: 0, expand: 0, invert: false };
  const docSize: [number, number] = [200, 160];
  const extent: [number, number] = [100, 80];

  function plane(
    refArg: Parameters<typeof rasterizeVectorMask>[2],
    consumerTransform: Transform2D,
  ): Uint8Array {
    return rasterizeVectorMask(
      paths,
      'nonzero',
      refArg,
      IDENTITY_TRANSFORM_2D,
      docSize,
      consumerTransform,
      extent,
      100,
      80,
      1,
    );
  }

  const moves: [string, Transform2D][] = [
    ['translation', { x: 100, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }],
    ['rotation 30deg', { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: Math.PI / 6 }],
    ['scale', { x: 0, y: 0, scaleX: 1.5, scaleY: 0.75, rotation: 0 }],
    ['all three', { x: 33, y: -12, scaleX: 1.25, scaleY: 1.25, rotation: -0.5 }],
  ];
  const attachedAt: Transform2D = { x: 12, y: 7, scaleX: 1, scaleY: 1, rotation: 0.2 };

  it('sanity: the fake produces a non-empty plane', () => {
    const p = plane(ref, attachedAt);
    expect(p.some((v) => v === 255)).toBe(true);
    expect(p.some((v) => v === 0)).toBe(true);
  });

  it.each(moves)(
    "node-pinned (%s): attached at T, consumer later at T' -> byte-identical to document-pinned while the consumer was at T",
    (_name, later) => {
      const documentAtT = plane(ref, attachedAt);
      const nodePinnedLater = plane({ ...ref, space: 'node', attachTransform: attachedAt }, later);
      expect(Array.from(nodePinnedLater)).toEqual(Array.from(documentAtT));
    },
  );

  it('document-pinned stays where it is on the page: moving the consumer changes the plane', () => {
    const atT = plane(ref, attachedAt);
    const atLater = plane(ref, moves[0][1]);
    expect(Array.from(atLater)).not.toEqual(Array.from(atT));
    // ...and an explicit space: 'document' is identical to an absent space.
    expect(Array.from(plane({ ...ref, space: 'document' }, moves[0][1]))).toEqual(
      Array.from(atLater),
    );
  });
});
