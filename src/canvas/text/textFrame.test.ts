import { describe, expect, it } from 'vitest';
import type { TextGeometry } from '@/fonts/textGeometry';
import type { FontRef } from '@/fonts/types';
import type { TextNode } from '@/scene/types';
import { boundsCornersDoc, DOUBLE_CLICK_MS, isDoubleClick } from './textFrame';

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
  kerning: 100,
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
