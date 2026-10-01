import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAll, ensureGeometry } from '@/scene/textGeometryCache';
import type { PixelNode, Scene, TextNode } from '@/scene/types';
import { topmostNodeAt } from './hitTest';

vi.mock('@/fonts/fontsIpc', () => ({
  textOutlines: vi.fn(async () => ({
    paths: [],
    lines: [],
    ascent: 0,
    descent: 0,
    bounds: { x: 0, y: -50, w: 100, h: 60 },
  })),
  listFonts: vi.fn(),
}));

function pixelNode(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
  return {
    id,
    label: id,
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    sourcePath: `/tmp/${id}.png`,
    sourceSize: [100, 100],
    ...overrides,
  };
}

function scene(nodes: (PixelNode | TextNode)[]): Scene {
  return {
    id: 's1',
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [200, 200],
  };
}

describe('topmostNodeAt', () => {
  it('returns the top-of-stack node (array index 0) when two overlap', () => {
    const top = pixelNode('top');
    const bottom = pixelNode('bottom');
    const s = scene([top, bottom]);
    expect(topmostNodeAt(s, { x: 50, y: 50 })?.id).toBe('top');
  });

  it('falls through to a lower node when the point misses the top node', () => {
    const top = pixelNode('top', {
      transform2d: { x: 500, y: 500, scaleX: 1, scaleY: 1, rotation: 0 },
    });
    const bottom = pixelNode('bottom');
    const s = scene([top, bottom]);
    expect(topmostNodeAt(s, { x: 50, y: 50 })?.id).toBe('bottom');
  });

  it('skips invisible and non-image-output nodes', () => {
    const hidden = pixelNode('hidden', { visible: false });
    const mask = pixelNode('mask', { output: 'mask' });
    const visible = pixelNode('visible');
    const s = scene([hidden, mask, visible]);
    expect(topmostNodeAt(s, { x: 50, y: 50 })?.id).toBe('visible');
  });

  it('returns undefined when nothing is hit', () => {
    const s = scene([pixelNode('a')]);
    expect(topmostNodeAt(s, { x: 500, y: 500 })).toBeUndefined();
  });

  it('honours a rotated node’s transformed bounds', () => {
    const rotated = pixelNode('r', {
      sourceSize: [100, 100],
      transform2d: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: Math.PI / 4 },
    });
    const s = scene([rotated]);
    // Centre (50,50); at 45 degrees the corner (100,100) rotates near (50, 50+70.7).
    expect(topmostNodeAt(s, { x: 50, y: 50 })?.id).toBe('r'); // centre always hits
    expect(topmostNodeAt(s, { x: 95, y: 95 })).toBeUndefined(); // corner rotated away
  });
});

describe('topmostNodeAt — text nodes', () => {
  function textNode(overrides: Partial<TextNode> = {}): TextNode {
    return {
      id: 't',
      label: 't',
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
      font: {
        family: 'Helvetica',
        style: 'Regular',
        postscriptName: 'Helvetica',
        weight: 400,
        italic: false,
        category: 'sans',
      },
      fontSize: 72,
      tracking: 0,
      kerning: 100,
      lineHeight: 1.2,
      align: 'left',
      fill: '#fff',
      stroke: null,
      position: { x: 20, y: 100 },
      ...overrides,
    };
  }

  beforeEach(() => clearAll());

  it('skips a node with no cached geometry', () => {
    expect(topmostNodeAt(scene([textNode()]), { x: 60, y: 90 })).toBeUndefined();
  });

  it('hits inside the position-translated glyph bounds and misses outside them', async () => {
    const node = textNode();
    await ensureGeometry(node); // bounds {0,-50,100,60} -> doc rect x 20..120, y 50..110
    const s = scene([node]);
    expect(topmostNodeAt(s, { x: 60, y: 90 })?.id).toBe('t');
    expect(topmostNodeAt(s, { x: 10, y: 90 })).toBeUndefined(); // left of the bounds
    expect(topmostNodeAt(s, { x: 60, y: 120 })).toBeUndefined(); // below the baseline box
    expect(topmostNodeAt(s, { x: 60, y: 40 })).toBeUndefined(); // above
  });

  it('falls through a text miss to the node below', async () => {
    const node = textNode();
    await ensureGeometry(node);
    const s = scene([node, pixelNode('below')]);
    expect(topmostNodeAt(s, { x: 10, y: 10 })?.id).toBe('below');
  });
});
