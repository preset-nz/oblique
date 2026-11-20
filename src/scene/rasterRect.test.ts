import { describe, expect, it } from 'vitest';
import type { TextGeometry } from '@/fonts/textGeometry';
import {
  logicalFrameFor,
  OVERFLOW_MARGIN_PX,
  OVERFLOW_STEP_PX,
  rasterRectFor,
  sameRect,
} from './rasterRect';
import type { PixelNode, SceneNode, TextNode, VectorNode } from './types';

const DOC: [number, number] = [2048, 1536];
const PAGE = { x: 0, y: 0, w: 2048, h: 1536 };

const base = {
  label: 'L',
  state: 'active' as const,
  output: 'image' as const,
  cameraId: null,
  modifiers: [],
  visible: true,
  blendMode: 'normal' as const,
  opacity: 1,
  dirty: { draft: false, working: false },
};

function pixel(sourceSize: [number, number]): PixelNode {
  return { ...base, id: 'p', type: 'pixel', sourcePath: 'a.png', sourceSize };
}

/** A vector rectangle from (x0, y0) to (x1, y1), corner anchors only. */
function box(x0: number, y0: number, x1: number, y1: number): VectorNode {
  return {
    ...base,
    id: 'v',
    type: 'vector',
    fillRule: 'nonzero',
    paths: [
      {
        closed: true,
        anchors: [
          { point: { x: x0, y: y0 } },
          { point: { x: x1, y: y0 } },
          { point: { x: x1, y: y1 } },
          { point: { x: x0, y: y1 } },
        ],
      },
    ],
  } as VectorNode;
}

function text(position: { x: number; y: number }, stroke: TextNode['stroke'] = null): TextNode {
  return {
    ...base,
    id: 't',
    type: 'text',
    content: 'Overflow',
    font: {
      family: 'Inter',
      style: 'Regular',
      postscriptName: 'Inter-Regular',
      weight: 400,
      italic: false,
    },
    fontSize: 72,
    tracking: 0,
    kerning: 100,
    lineHeight: 1.2,
    align: 'left',
    fill: '#ffffff',
    stroke,
    position,
  } as unknown as TextNode;
}

/** Glyph bounds in anchor space (origin on the baseline): `w` wide, from 60 above it to 10 below. */
function geometry(w: number): TextGeometry {
  return {
    paths: [],
    lines: [],
    ascent: 60,
    descent: 10,
    bounds: { x: 0, y: -60, w, h: 70 },
  };
}

describe('rasterRectFor', () => {
  it('a pixel layer: its sourceSize at the origin, whatever the page', () => {
    expect(rasterRectFor(pixel([640, 480]), DOC)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
  });

  it('a vector shape well inside the page: exactly the page', () => {
    expect(rasterRectFor(box(100, 100, 900, 700), DOC)).toEqual(PAGE);
  });

  it('a shape inside the page but within the margin of every edge is still exactly the page', () => {
    // the byte-identical rule: only a side the content crosses grows
    expect(rasterRectFor(box(1, 1, 2047, 1535), DOC)).toEqual(PAGE);
    expect(rasterRectFor(box(0, 0, 2048, 1536), DOC)).toEqual(PAGE);
    expect(rasterRectFor(text({ x: 10, y: 80 }), DOC, geometry(500))).toEqual(PAGE);
  });

  it('past the right edge: the right side grows by the margin, snapped out to the step', () => {
    const r = rasterRectFor(box(1800, 100, 2300, 400), DOC);
    // 2300 + 64 = 2364, up to the next multiple of 64
    expect(r).toEqual({ x: 0, y: 0, w: 2368, h: 1536 });
    expect((r.x + r.w) % OVERFLOW_STEP_PX).toBe(0);
    expect(r.x + r.w).toBeGreaterThanOrEqual(2300 + OVERFLOW_MARGIN_PX);
  });

  it('past the left and top edges: a negative origin, snapped from the document origin', () => {
    const r = rasterRectFor(box(-300, -10, 400, 400), DOC);
    // -300 - 64 = -364 -> -384; -10 - 64 = -74 -> -128
    expect(r).toEqual({ x: -384, y: -128, w: 2048 + 384, h: 1536 + 128 });
  });

  it('past the bottom only grows the bottom', () => {
    expect(rasterRectFor(box(100, 1400, 600, 1700), DOC)).toEqual({
      x: 0,
      y: 0,
      w: 2048,
      h: 1792,
    });
  });

  it('the snap keeps the origin still while a line grows leftwards a few px at a time', () => {
    const origins = [-100, -103, -110, -120].map((x) => rasterRectFor(box(x, 10, 300, 50), DOC).x);
    expect(new Set(origins).size).toBe(1);
  });

  it('is clamped to one page beyond each edge', () => {
    expect(rasterRectFor(box(-9000, -9000, 9000, 9000), DOC)).toEqual({
      x: -2048,
      y: -1536,
      w: 3 * 2048,
      h: 3 * 1536,
    });
  });

  it('content entirely right of the page: the page plus the reach to it', () => {
    expect(rasterRectFor(box(2500, 100, 2600, 200), DOC)).toEqual({
      x: 0,
      y: 0,
      w: 2688,
      h: 1536,
    });
  });

  it('text: the glyph bounds moved by position', () => {
    // 1700 .. 2300 across: 2300 + 64 = 2364, up to 2368
    expect(rasterRectFor(text({ x: 1700, y: 200 }), DOC, geometry(600))).toEqual({
      x: 0,
      y: 0,
      w: 2368,
      h: 1536,
    });
    // past the left edge
    expect(rasterRectFor(text({ x: -200, y: 200 }), DOC, geometry(600)).x).toBe(-320);
  });

  it("text: the stroke's half-width counts as content", () => {
    // glyphs end exactly at the page's right edge; a 20 px stroke reaches 10 px past it
    const flush = text({ x: 1448, y: 200 });
    expect(rasterRectFor(flush, DOC, geometry(600))).toEqual(PAGE);
    const stroked = text({ x: 1448, y: 200 }, { color: '#000000', width: 20 });
    expect(rasterRectFor(stroked, DOC, geometry(600)).w).toBe(2048 + 64 + 64);
  });

  it('text without geometry yet, or with empty bounds: the page', () => {
    expect(rasterRectFor(text({ x: -500, y: 0 }), DOC)).toEqual(PAGE);
    expect(rasterRectFor(text({ x: -500, y: 0 }), DOC, { ...geometry(10), bounds: null })).toEqual(
      PAGE,
    );
  });

  it('a vector layer with no paths: the page', () => {
    expect(rasterRectFor({ ...box(0, 0, 1, 1), paths: [] } as SceneNode, DOC)).toEqual(PAGE);
  });
});

describe('logicalFrameFor / sameRect', () => {
  it('the frame is sourceSize for pixel and the page otherwise', () => {
    expect(logicalFrameFor(pixel([10, 20]), DOC)).toEqual({ x: 0, y: 0, w: 10, h: 20 });
    expect(logicalFrameFor(box(0, 0, 1, 1), DOC)).toEqual(PAGE);
    expect(sameRect(PAGE, { ...PAGE })).toBe(true);
    expect(sameRect(PAGE, { ...PAGE, x: -64 })).toBe(false);
  });
});
