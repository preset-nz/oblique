import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cache from './cache';
import { deleteNode } from './deleteNode';
import * as sources from './sources';
import { useSceneStore } from './store';
import type { PixelNode } from './types';

function pixelNode(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
  return {
    id,
    label: 'Layer',
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    sourcePath: '/tmp/a.png',
    sourceSize: [100, 100],
    ...overrides,
  };
}

function fakeBitmap(): ImageBitmap {
  return { width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap;
}

beforeEach(() => {
  cache.clearAll();
  sources.clearAll();
  useSceneStore.setState({
    scene: {
      ...useSceneStore.getState().scene,
      nodes: [pixelNode('a'), pixelNode('b')],
    },
  });
});

describe('deleteNode', () => {
  it('removes the node from the scene and leaves the others', () => {
    deleteNode('a');

    const ids = useSceneStore.getState().scene.nodes.map((n) => n.id);
    expect(ids).toEqual(['b']);
  });

  it('evicts and closes every cache level for the deleted node only', () => {
    const draftA = fakeBitmap();
    const workingA = fakeBitmap();
    const draftB = fakeBitmap();
    cache.set('a', 'draft', draftA);
    cache.set('a', 'working', workingA);
    cache.set('b', 'draft', draftB);

    deleteNode('a');

    expect(cache.get('a', 'draft')).toBeUndefined();
    expect(cache.get('a', 'working')).toBeUndefined();
    expect(draftA.close).toHaveBeenCalled();
    expect(workingA.close).toHaveBeenCalled();
    expect(cache.get('b', 'draft')).toBe(draftB);
    expect(draftB.close).not.toHaveBeenCalled();
  });

  it('drops the decoded source bitmap', () => {
    const source = fakeBitmap();
    sources.set('a', source);

    deleteNode('a');

    expect(sources.get('a')).toBeUndefined();
  });

  it('does not set any dirty flag on surviving nodes (compositing-only mutation)', () => {
    deleteNode('a');

    const [b] = useSceneStore.getState().scene.nodes;
    expect(b.dirty).toEqual({ draft: false, working: false });
  });
});
