import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from './store';
import type { Modifier, PixelNode, Scene } from './types';

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

function modifier(id: string, overrides: Partial<Modifier> = {}): Modifier {
  return { id, type: 'gaussian_blur', enabled: true, params: { radius: 4 }, ...overrides };
}

beforeEach(() => {
  useSceneStore.setState({
    scene: {
      id: 'scene-1',
      nodes: [],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [0, 0],
    },
  });
});

describe('addPixelNode', () => {
  it('inserts the new node at index 0 (stack top)', () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    const secondId = useSceneStore
      .getState()
      .addPixelNode({ sourcePath: '/b.png', sourceSize: [10, 10] });

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes[0].id).toBe(secondId);
    expect(nodes).toHaveLength(2);
  });

  it('marks the new node dirty at both levels', () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    const node = useSceneStore.getState().scene.nodes[0];
    expect(node.dirty).toEqual({ draft: true, working: true });
  });
});

describe('removeNode', () => {
  it('removes the node by id', () => {
    const id = useSceneStore
      .getState()
      .addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    useSceneStore.getState().removeNode(id);
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });
});

describe('reorderNode', () => {
  it('moves the node to the target index', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a'), pixelNode('b'), pixelNode('c')] },
    }));
    useSceneStore.getState().reorderNode('c', 0);
    expect(useSceneStore.getState().scene.nodes.map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('does NOT set any dirty flag (compositing-only, dirty rule 4)', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          pixelNode('a', { dirty: { draft: false, working: false } }),
          pixelNode('b', { dirty: { draft: false, working: false } }),
        ],
      },
    }));
    useSceneStore.getState().reorderNode('b', 0);
    for (const node of useSceneStore.getState().scene.nodes) {
      expect(node.dirty).toEqual({ draft: false, working: false });
    }
  });
});

describe('setNodeProp', () => {
  it('updates visible/blendMode/opacity/label', () => {
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [pixelNode('a')] } }));
    useSceneStore
      .getState()
      .setNodeProp('a', { visible: false, blendMode: 'multiply', opacity: 0.5, label: 'Sky' });
    const node = useSceneStore.getState().scene.nodes[0];
    expect(node.visible).toBe(false);
    expect(node.blendMode).toBe('multiply');
    expect(node.opacity).toBe(0.5);
    expect(node.label).toBe('Sky');
  });

  it('does NOT set any dirty flag (compositing-only, dirty rule 4)', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { dirty: { draft: false, working: false } })] },
    }));
    useSceneStore.getState().setNodeProp('a', { opacity: 0.2 });
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({
      draft: false,
      working: false,
    });
  });
});

describe('addModifier', () => {
  it('appends a modifier with the given type and defaults', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { dirty: { draft: false, working: false } })] },
    }));
    useSceneStore.getState().addModifier('a', 'gaussian_blur', { radius: 2 });
    const mods = useSceneStore.getState().scene.nodes[0].modifiers;
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ type: 'gaussian_blur', enabled: true, params: { radius: 2 } });
  });

  it('marks the node dirty at draft (and working, rule 1)', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { dirty: { draft: false, working: false } })] },
    }));
    useSceneStore.getState().addModifier('a', 'gaussian_blur', { radius: 2 });
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });
});

describe('removeModifier', () => {
  it('removes the modifier by id and marks the node dirty', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          pixelNode('a', {
            modifiers: [modifier('m1')],
            dirty: { draft: false, working: false },
          }),
        ],
      },
    }));
    useSceneStore.getState().removeModifier('a', 'm1');
    const node = useSceneStore.getState().scene.nodes[0];
    expect(node.modifiers).toHaveLength(0);
    expect(node.dirty).toEqual({ draft: true, working: true });
  });
});

describe('reorderModifier', () => {
  it('moves the modifier to the target index', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [pixelNode('a', { modifiers: [modifier('m1'), modifier('m2')] })],
      },
    }));
    useSceneStore.getState().reorderModifier('a', 'm2', 0);
    expect(useSceneStore.getState().scene.nodes[0].modifiers.map((m) => m.id)).toEqual([
      'm2',
      'm1',
    ]);
  });

  it('marks the node dirty (pixels change, unlike node reorder)', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          pixelNode('a', {
            modifiers: [modifier('m1'), modifier('m2')],
            dirty: { draft: false, working: false },
          }),
        ],
      },
    }));
    useSceneStore.getState().reorderModifier('a', 'm2', 0);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });
});

describe('setModifierParam', () => {
  it('updates the given param key, leaving others intact', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [pixelNode('a', { modifiers: [modifier('m1', { params: { radius: 4 } })] })],
      },
    }));
    useSceneStore.getState().setModifierParam('a', 'm1', 'radius', 9);
    expect(useSceneStore.getState().scene.nodes[0].modifiers[0].params).toEqual({ radius: 9 });
  });

  it('marks the node dirty at draft', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          pixelNode('a', {
            modifiers: [modifier('m1')],
            dirty: { draft: false, working: false },
          }),
        ],
      },
    }));
    useSceneStore.getState().setModifierParam('a', 'm1', 'radius', 9);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });
});

describe('setModifierEnabled', () => {
  it('toggles the enabled flag', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { modifiers: [modifier('m1')] })] },
    }));
    useSceneStore.getState().setModifierEnabled('a', 'm1', false);
    expect(useSceneStore.getState().scene.nodes[0].modifiers[0].enabled).toBe(false);
  });

  it('marks the node dirty (pixels change)', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          pixelNode('a', {
            modifiers: [modifier('m1')],
            dirty: { draft: false, working: false },
          }),
        ],
      },
    }));
    useSceneStore.getState().setModifierEnabled('a', 'm1', false);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });
});

describe('markDirty', () => {
  it('rule 1: marking draft dirty also dirties working', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { dirty: { draft: false, working: false } })] },
    }));
    useSceneStore.getState().markDirty('a', 'draft');
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it('rule 2: marking working dirty leaves draft untouched', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { dirty: { draft: false, working: false } })] },
    }));
    useSceneStore.getState().markDirty('a', 'working');
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({
      draft: false,
      working: true,
    });
  });
});

describe('clearDirty', () => {
  it('rule 5: clears only the given level', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { dirty: { draft: true, working: true } })] },
    }));
    useSceneStore.getState().clearDirty('a', 'working');
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: false });

    useSceneStore.getState().clearDirty('a', 'draft');
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({
      draft: false,
      working: false,
    });
  });
});

describe('loadScene', () => {
  it('replaces the scene verbatim, without touching dirty flags', () => {
    const incoming: Scene = {
      id: 'loaded',
      nodes: [pixelNode('x', { dirty: { draft: true, working: false } })],
      cameras: [],
      defaultCameraId: null,
      resolution: 'draft',
      documentSize: [200, 100],
    };
    useSceneStore.getState().loadScene(incoming);
    expect(useSceneStore.getState().scene).toEqual(incoming);
  });
});

describe('JSON round-trip', () => {
  it('a scene with two nodes and three modifiers deep-equals after round-trip', () => {
    const scene: Scene = {
      id: 'scene-rt',
      nodes: [
        pixelNode('n1', {
          modifiers: [modifier('m1'), modifier('m2', { type: 'levels', params: { gamma: 1.2 } })],
        }),
        pixelNode('n2', { modifiers: [modifier('m3', { type: 'invert', params: {} })] }),
      ],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [1024, 768],
    };
    const roundTripped = JSON.parse(JSON.stringify(scene));
    expect(roundTripped).toEqual(scene);
  });

  it('is structuredClone-able after a JSON round trip (no non-serialisable values)', () => {
    const scene: Scene = {
      id: 'scene-sc',
      nodes: [pixelNode('n1', { modifiers: [modifier('m1')] })],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [512, 512],
    };
    expect(() => structuredClone(JSON.parse(JSON.stringify(scene)))).not.toThrow();
  });

  it('the live store never leaks a non-serialisable value after normal actions', () => {
    const id = useSceneStore
      .getState()
      .addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    useSceneStore.getState().addModifier(id, 'gaussian_blur', { radius: 4 });
    useSceneStore.getState().setNodeProp(id, { opacity: 0.5 });
    useSceneStore.getState().reorderNode(id, 0);

    const scene = useSceneStore.getState().scene;
    expect(() => structuredClone(JSON.parse(JSON.stringify(scene)))).not.toThrow();
  });
});
