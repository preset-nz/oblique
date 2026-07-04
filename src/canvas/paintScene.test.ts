import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cache from '@/scene/cache';
import type { SceneNode } from '@/scene/types';
import { findTopmostImageNode, pickBestCache } from './paintScene';

function makeNode(id: string, overrides: Partial<SceneNode> = {}): SceneNode {
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
    ...overrides,
  } as SceneNode;
}

function fakeBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

describe('findTopmostImageNode', () => {
  it('returns the first (topmost) visible image-output node', () => {
    const nodes = [makeNode('top'), makeNode('bottom')];
    expect(findTopmostImageNode(nodes)?.id).toBe('top');
  });

  it('skips hidden nodes', () => {
    const nodes = [makeNode('top', { visible: false }), makeNode('bottom')];
    expect(findTopmostImageNode(nodes)?.id).toBe('bottom');
  });

  it('skips non-image-output nodes', () => {
    const nodes = [makeNode('mask', { output: 'mask' }), makeNode('image')];
    expect(findTopmostImageNode(nodes)?.id).toBe('image');
  });

  it('returns undefined for an empty stack', () => {
    expect(findTopmostImageNode([])).toBeUndefined();
  });
});

describe('pickBestCache', () => {
  beforeEach(() => {
    cache.clearAll();
  });

  it('prefers WORKING over DRAFT when both exist', () => {
    const draft = fakeBitmap();
    const working = fakeBitmap();
    cache.set('n1', 'draft', draft);
    cache.set('n1', 'working', working);
    expect(pickBestCache('n1')).toBe(working);
  });

  it('falls back to DRAFT when WORKING is not yet cooked', () => {
    const draft = fakeBitmap();
    cache.set('n1', 'draft', draft);
    expect(pickBestCache('n1')).toBe(draft);
  });

  it('returns undefined when nothing is cached yet', () => {
    expect(pickBestCache('n1')).toBeUndefined();
  });
});
