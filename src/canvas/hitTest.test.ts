import { describe, expect, it } from 'vitest';
import type { PixelNode, Scene } from '@/scene/types';
import { topmostNodeAt } from './hitTest';

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

function scene(nodes: PixelNode[]): Scene {
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
