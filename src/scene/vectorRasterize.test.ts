import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextGeometry } from '@/fonts/textGeometry';
import { rasterizeText } from './textRasterize';
import type { TextNode, VectorPath } from './types';
import { type PathCommand, pathCommandsFor, rasterizeVector } from './vectorRasterize';

// `rasterizeVector` itself needs OffscreenCanvas/Path2D (browser-only), so
// this suite covers the pure command derivation — the one place this
// module's own code could introduce non-determinism (Path2D's fill given
// identical commands is deterministic by browser contract; that's not this
// module's to re-prove) — and, at the end, the context calls the rasterisers
// make over a raster rect, through a recording stand-in. Evenodd-hole
// behaviour isn't headlessly verifiable here.

describe('pathCommandsFor', () => {
  it('a triangle of corner anchors: moveTo + lineTo + lineTo + closePath', () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 10, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands).toEqual<PathCommand[]>([
      { op: 'moveTo', to: { x: 0, y: 0 } },
      { op: 'lineTo', to: { x: 10, y: 0 } },
      { op: 'lineTo', to: { x: 5, y: 10 } },
      { op: 'lineTo', to: { x: 0, y: 0 } },
      { op: 'closePath' },
    ]);
  });

  it('an anchor with a handle draws a cubic segment, using the anchor point as the missing control point', () => {
    const paths: VectorPath[] = [
      {
        closed: false,
        anchors: [
          { point: { x: 0, y: 0 }, handleOut: { x: 2, y: 2 } },
          { point: { x: 10, y: 0 }, handleIn: { x: 8, y: 2 } },
        ],
      },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands).toEqual<PathCommand[]>([
      { op: 'moveTo', to: { x: 0, y: 0 } },
      {
        op: 'bezierCurveTo',
        c1: { x: 2, y: 2 },
        c2: { x: 8, y: 2 },
        to: { x: 10, y: 0 },
      },
    ]);
  });

  it('an open path never gets a closing segment', () => {
    const paths: VectorPath[] = [
      {
        closed: false,
        anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }],
      },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands).toEqual<PathCommand[]>([
      { op: 'moveTo', to: { x: 0, y: 0 } },
      { op: 'lineTo', to: { x: 10, y: 0 } },
    ]);
  });

  it('multiple paths each start their own moveTo (separate contours)', () => {
    const paths: VectorPath[] = [
      { closed: false, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 1, y: 1 } }] },
      { closed: false, anchors: [{ point: { x: 5, y: 5 } }, { point: { x: 6, y: 6 } }] },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands.filter((c) => c.op === 'moveTo')).toHaveLength(2);
  });

  it('an empty path contributes no commands', () => {
    expect(pathCommandsFor([{ closed: true, anchors: [] }])).toEqual([]);
  });

  it('is deterministic: identical paths always produce an identical command list', () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 }, handleOut: { x: 2, y: 2 } },
          { point: { x: 10, y: 0 }, handleIn: { x: 8, y: -2 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ];

    expect(pathCommandsFor(paths)).toEqual(pathCommandsFor(paths));
  });
});

// ---------------------------------------------------------------- the raster rect (layer-overflow.md)

/**
 * A recording stand-in for OffscreenCanvas/Path2D: every call the rasteriser makes on the
 * context, in order, with the canvas size it asked for. Path2D's fill is deterministic for
 * identical calls (the browser's contract, as above), so identical call lists are identical
 * bytes: the headless proof that a layer on the page draws exactly what it drew before the rect.
 */
function recordingCanvas(): { calls: unknown[][]; install: () => void } {
  const calls: unknown[][] = [];
  class FakePath2D {
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    closePath() {}
  }
  class FakeOffscreenCanvas {
    constructor(w: number, h: number) {
      calls.push(['canvas', w, h]);
    }
    getContext() {
      const record =
        (name: string) =>
        (...args: unknown[]) => {
          calls.push([name, ...args.filter((a) => !(a instanceof FakePath2D))]);
        };
      return {
        setTransform: record('setTransform'),
        translate: record('translate'),
        fill: record('fill'),
        stroke: record('stroke'),
        set fillStyle(v: string) {
          calls.push(['fillStyle', v]);
        },
        set strokeStyle(v: string) {
          calls.push(['strokeStyle', v]);
        },
        set lineWidth(v: number) {
          calls.push(['lineWidth', v]);
        },
        set lineJoin(v: string) {
          calls.push(['lineJoin', v]);
        },
        getImageData: (...args: number[]) => {
          calls.push(['getImageData', ...args]);
          return { data: new Uint8ClampedArray(args[2] * args[3] * 4) };
        },
      };
    }
  }
  return {
    calls,
    install: () => {
      vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
      vi.stubGlobal('Path2D', FakePath2D);
    },
  };
}

describe('rasterizeVector over a raster rect', () => {
  afterEach(() => vi.unstubAllGlobals());
  const paths: VectorPath[] = [
    { closed: true, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }] },
  ];

  it('a layer on the page (rect = page) makes exactly the calls of the old document-sized path', () => {
    const rec = recordingCanvas();
    rec.install();
    rasterizeVector(paths, 'evenodd', { x: 0, y: 0, w: 800, h: 400 }, 100, 50, 1 / 8);
    // the old path: canvas at documentSize x factor, factor transform, white fill, read back
    expect(rec.calls).toEqual([
      ['canvas', 100, 50],
      ['setTransform', 1 / 8, 0, 0, 1 / 8, 0, 0],
      ['fillStyle', '#fff'],
      ['fill', 'evenodd'],
      ['getImageData', 0, 0, 100, 50],
    ]);
  });

  it('a grown rect shifts document px by its origin, after the factor', () => {
    const rec = recordingCanvas();
    rec.install();
    rasterizeVector(paths, 'nonzero', { x: -128, y: -64, w: 1056, h: 528 }, 132, 66, 1 / 8);
    expect(rec.calls.slice(0, 3)).toEqual([
      ['canvas', 132, 66],
      ['setTransform', 1 / 8, 0, 0, 1 / 8, 0, 0],
      ['translate', 128, 64],
    ]);
  });
});

describe('rasterizeText over a raster rect', () => {
  afterEach(() => vi.unstubAllGlobals());
  const geometry: TextGeometry = { paths: [], lines: [], ascent: 0, descent: 0, bounds: null };
  const node = {
    position: { x: 30, y: 40 },
    fill: '#ff0000',
    stroke: { color: '#000000', width: 4 },
  } as unknown as TextNode;

  it('a layer on the page (rect = page) makes exactly the calls of the old document-sized path', () => {
    const rec = recordingCanvas();
    rec.install();
    rasterizeText(node, geometry, { x: 0, y: 0, w: 800, h: 400 }, 400, 200, 1 / 2);
    expect(rec.calls).toEqual([
      ['canvas', 400, 200],
      ['setTransform', 1 / 2, 0, 0, 1 / 2, 0, 0],
      ['translate', 30, 40],
      ['fillStyle', '#ff0000'],
      ['fill', 'nonzero'],
      ['lineJoin', 'round'],
      ['lineWidth', 4],
      ['strokeStyle', '#000000'],
      ['stroke'],
      ['getImageData', 0, 0, 400, 200],
    ]);
  });

  it('a rect reaching past the left edge shifts by its origin before the position', () => {
    const rec = recordingCanvas();
    rec.install();
    rasterizeText(node, geometry, { x: -192, y: 0, w: 992, h: 400 }, 496, 200, 1 / 2);
    expect(rec.calls.slice(0, 4)).toEqual([
      ['canvas', 496, 200],
      ['setTransform', 1 / 2, 0, 0, 1 / 2, 0, 0],
      ['translate', 192, -0],
      ['translate', 30, 40],
    ]);
  });
});
