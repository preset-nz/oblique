import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cache from './cache';
import { deleteNode } from './deleteNode';
import * as prefixStore from './prefixStore';
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
  prefixStore.clearAll();
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

  it("drops the deleted node's prefix-cache state, and only that node's", () => {
    const entry = {
      descriptor: { source: 's', width: 1, height: 1, modifiers: ['x'] },
      bytes: new Uint8Array(4),
    };
    prefixStore.setPrefix('a', 'draft', entry);
    prefixStore.setLastStack('a', 'draft', ['x']);
    prefixStore.setPrefix('b', 'draft', entry);

    deleteNode('a');

    expect(prefixStore.getPrefix('a', 'draft')).toBeUndefined();
    expect(prefixStore.getLastStack('a', 'draft')).toBeUndefined();
    expect(prefixStore.getPrefix('b', 'draft')).toBe(entry);
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

  describe('when the store drops the layer later (a command that has to come back first)', () => {
    const { removeNode } = useSceneStore.getState();
    afterEach(() => useSceneStore.setState({ removeNode }));

    it('evicts only once the layer is gone from the scene', () => {
      useSceneStore.setState({ removeNode: vi.fn() }); // sent, not yet answered
      const bitmap = fakeBitmap();
      cache.set('a', 'draft', bitmap);
      sources.set('a', bitmap);

      deleteNode('a');
      expect(cache.get('a', 'draft')).toBe(bitmap);
      expect(sources.get('a')).toBe(bitmap);
      expect(bitmap.close).not.toHaveBeenCalled();

      // the update lands: the layer goes
      removeNode('a');
      expect(cache.get('a', 'draft')).toBeUndefined();
      expect(sources.get('a')).toBeUndefined();
      expect(bitmap.close).toHaveBeenCalled();
    });

    it('a refused remove (the layer stays) evicts nothing', () => {
      useSceneStore.setState({ removeNode: vi.fn() });
      const bitmap = fakeBitmap();
      cache.set('a', 'draft', bitmap);
      deleteNode('a');
      useSceneStore.setState({ bakingNodeIds: new Set(['b']) }); // other store changes
      expect(cache.get('a', 'draft')).toBe(bitmap);
      expect(bitmap.close).not.toHaveBeenCalled();
      removeNode('a'); // leave nothing waiting for later tests
    });
  });
});
