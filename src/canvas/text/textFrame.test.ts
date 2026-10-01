import { describe, expect, it } from 'vitest';
import type { TextGeometry } from '@/fonts/textGeometry';
import type { FontRef } from '@/fonts/types';
import type { TextNode } from '@/scene/types';
import {
  boundsCornersDoc,
  DOUBLE_CLICK_MS,
  editorAnchorDoc,
  editorAnchorLocal,
  isDoubleClick,
} from './textFrame';

const font: FontRef = {
  family: 'Helvetica',
  style: 'Regular',
  postscriptName: 'Helvetica',
  weight: 400,
  italic: false,
  category: 'sans',
};

const node = (overrides: Partial<TextNode> = {}): TextNode => ({
  id: 't',
  label: 'T',
  type: 'text',
  state: 'active',
  output: 'image',
  cameraId: null,
  modifiers: [],
  visible: true,
  blendMode: 'normal',
  opacity: 1,
  dirty: { draft: false, working: false },
  content: 'HI',
  font,
  fontSize: 100,
  tracking: 0,
  kerning: true,
  lineHeight: 1.2,
  align: 'left',
  fill: '#ffffff',
  stroke: null,
  position: { x: 50, y: 200 },
  ...overrides,
});

const geometry = (bounds: TextGeometry['bounds']): TextGeometry => ({
  paths: [],
  lines: [],
  ascent: 80,
  descent: 20,
  bounds,
});

const DOC: [number, number] = [1000, 600];

describe('editorAnchorDoc', () => {
  it("sits at the glyph bounds' top-left, translated by position", () => {
    const g = geometry({ x: 4, y: -75, w: 120, h: 90 });
    expect(editorAnchorLocal(node(), g)).toEqual({ x: 54, y: 125 });
    expect(editorAnchorDoc(node(), g, DOC)).toEqual({ x: 54, y: 125 });
  });

  it('falls back to the baseline lifted by the ascent when there are no bounds yet', () => {
    expect(editorAnchorLocal(node(), geometry(null))).toEqual({ x: 50, y: 120 });
    // no geometry at all: 0.8 em
    expect(editorAnchorLocal(node(), undefined)).toEqual({ x: 50, y: 120 });
  });

  it('follows the node after a Move-tool drag (transform2d translation)', () => {
    const g = geometry({ x: 4, y: -75, w: 120, h: 90 });
    const moved = node({ transform2d: { x: 300, y: -40, rotation: 0, scaleX: 1, scaleY: 1 } });
    expect(editorAnchorDoc(moved, g, DOC)).toEqual({ x: 354, y: 85 });
  });

  it('maps through scale about the raster centre, the same as the compositor', () => {
    const g = geometry({ x: 0, y: 0, w: 10, h: 10 });
    const n = node({
      position: { x: 500, y: 300 }, // the raster centre
      transform2d: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 },
    });
    expect(editorAnchorDoc(n, g, DOC)).toEqual({ x: 500, y: 300 });
  });
});

describe('boundsCornersDoc', () => {
  it('is empty without bounds and four corners with them', () => {
    expect(boundsCornersDoc(node(), geometry(null), DOC)).toEqual([]);
    const corners = boundsCornersDoc(node(), geometry({ x: 0, y: -80, w: 100, h: 100 }), DOC);
    expect(corners).toEqual([
      { x: 50, y: 120 },
      { x: 150, y: 120 },
      { x: 150, y: 220 },
      { x: 50, y: 220 },
    ]);
  });
});

describe('isDoubleClick', () => {
  const at = (t: number, x = 10, y = 10, nodeId = 'a') => ({ t, x, y, nodeId });
  it('needs a previous click on the same node, close in time and place', () => {
    expect(isDoubleClick(null, at(0))).toBe(false);
    expect(isDoubleClick(at(0), at(100))).toBe(true);
    expect(isDoubleClick(at(0), at(100, 12, 11))).toBe(true);
    expect(isDoubleClick(at(0), at(DOUBLE_CLICK_MS + 1))).toBe(false);
    expect(isDoubleClick(at(0), at(100, 40, 10))).toBe(false);
    expect(isDoubleClick(at(0), at(100, 10, 10, 'b'))).toBe(false);
  });
});
