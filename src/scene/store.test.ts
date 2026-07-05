import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from './store';
import type { Modifier, PixelNode, Scene, VectorNode, VectorPath } from './types';
import { IDENTITY_TRANSFORM_2D } from './types';

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

function vectorNode(id: string, overrides: Partial<VectorNode> = {}): VectorNode {
  return {
    id,
    label: 'Vector',
    type: 'vector',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    paths: [],
    fillRule: 'nonzero',
    ...overrides,
  };
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

const trianglePaths: VectorPath[] = [
  {
    closed: true,
    anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 5, y: 10 } }],
  },
];

describe('addVectorNode', () => {
  it('inserts the new node at index 0 (stack top)', () => {
    useSceneStore.getState().addVectorNode({ paths: trianglePaths, fillRule: 'nonzero' });
    const secondId = useSceneStore
      .getState()
      .addVectorNode({ paths: trianglePaths, fillRule: 'evenodd' });

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes[0].id).toBe(secondId);
    expect(nodes).toHaveLength(2);
  });

  it('marks the new node dirty at both levels', () => {
    useSceneStore.getState().addVectorNode({ paths: trianglePaths, fillRule: 'nonzero' });
    const node = useSceneStore.getState().scene.nodes[0];
    expect(node.dirty).toEqual({ draft: true, working: true });
  });

  it('carries paths/fillRule, no sourcePath/sourceSize', () => {
    const id = useSceneStore
      .getState()
      .addVectorNode({ paths: trianglePaths, fillRule: 'evenodd' });
    const node = useSceneStore.getState().scene.nodes[0];
    expect(node.id).toBe(id);
    expect(node.type).toBe('vector');
    expect(node).toMatchObject({ paths: trianglePaths, fillRule: 'evenodd' });
    expect(node).not.toHaveProperty('sourcePath');
    expect(node).not.toHaveProperty('sourceSize');
  });
});

describe('setVectorPaths', () => {
  it('replaces paths and dirties the node at both levels', () => {
    const id = useSceneStore
      .getState()
      .addVectorNode({ paths: trianglePaths, fillRule: 'nonzero' });
    useSceneStore.getState().clearDirty(id, 'draft');
    useSceneStore.getState().clearDirty(id, 'working');

    const nextPaths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 20, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ];
    useSceneStore.getState().setVectorPaths(id, nextPaths);

    const node = useSceneStore.getState().scene.nodes[0];
    expect(node).toMatchObject({ paths: nextPaths });
    expect(node.dirty).toEqual({ draft: true, working: true });
  });

  it('is a no-op on a non-vector node id', () => {
    const id = useSceneStore
      .getState()
      .addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    useSceneStore.getState().setVectorPaths(id, trianglePaths);
    const node = useSceneStore.getState().scene.nodes[0];
    expect(node).not.toHaveProperty('paths');
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

  it('toggles output image<->mask without dirtying (mask-span-scoping.md)', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a', { dirty: { draft: false, working: false } })] },
    }));
    useSceneStore.getState().setNodeProp('a', { output: 'mask' });
    const node = useSceneStore.getState().scene.nodes[0];
    expect(node.output).toBe('mask');
    expect(node.dirty).toEqual({ draft: false, working: false });
  });
});

describe('setNodeTransform', () => {
  it('replaces the node transform wholesale', () => {
    useSceneStore.setState((s) => ({
      scene: { ...s.scene, nodes: [pixelNode('a')] },
    }));
    const t = { x: 30, y: -10, scaleX: 2, scaleY: 0.5, rotation: Math.PI / 4 };
    useSceneStore.getState().setNodeTransform('a', t);
    expect(useSceneStore.getState().scene.nodes[0].transform2d).toEqual(t);
  });

  it('dirties NOTHING in a 5-node stack — dragging fires zero cooks (node-transform-2d.md acceptance)', () => {
    const clean = { draft: false, working: false } as const;
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => pixelNode(id, { dirty: { ...clean } })),
      },
    }));
    // A drag is many setNodeTransform calls in a row — none may dirty.
    for (let i = 1; i <= 3; i++) {
      useSceneStore
        .getState()
        .setNodeTransform('c', { x: i * 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
    }
    for (const node of useSceneStore.getState().scene.nodes) {
      expect(node.dirty).toEqual(clean);
    }
    expect(useSceneStore.getState().scene.nodes[2].transform2d?.x).toBe(30);
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

describe('setModifierMask / removeModifierMask', () => {
  const maskDef = {
    shape: { kind: 'rect' as const, rect: { x: 10, y: 10, w: 40, h: 20 } },
    appliedTransform2d: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    featherPx: 6,
    expand: 0,
    invert: false,
  };

  function nodeWithModifier() {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          pixelNode('n1', {
            modifiers: [modifier('m1')],
            dirty: { draft: false, working: false },
          }),
        ],
      },
    }));
  }

  it('stores the mask, points the modifier at it, and dirties both levels', () => {
    nodeWithModifier();
    const maskId = useSceneStore.getState().setModifierMask('n1', 'm1', maskDef);

    const scene = useSceneStore.getState().scene;
    expect(scene.masks?.[maskId]).toEqual({ ...maskDef, id: maskId });
    expect(scene.nodes[0].modifiers[0].maskId).toBe(maskId);
    expect(scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it('replacing a mask reuses the same id (a replace IS an edit)', () => {
    nodeWithModifier();
    const first = useSceneStore.getState().setModifierMask('n1', 'm1', maskDef);
    const second = useSceneStore
      .getState()
      .setModifierMask('n1', 'm1', { ...maskDef, featherPx: 20 });

    expect(second).toBe(first);
    const scene = useSceneStore.getState().scene;
    expect(scene.masks?.[first]?.featherPx).toBe(20);
    expect(Object.keys(scene.masks ?? {})).toHaveLength(1);
  });

  it('removeModifierMask drops the maskId and prunes the orphaned entry', () => {
    nodeWithModifier();
    useSceneStore.getState().setModifierMask('n1', 'm1', maskDef);
    useSceneStore.getState().removeModifierMask('n1', 'm1');

    const scene = useSceneStore.getState().scene;
    expect(scene.nodes[0].modifiers[0].maskId).toBeUndefined();
    expect(scene.masks).toEqual({});
    expect(scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it('removing a masked modifier prunes its mask entry (1:1)', () => {
    nodeWithModifier();
    useSceneStore.getState().setModifierMask('n1', 'm1', maskDef);
    useSceneStore.getState().removeModifier('n1', 'm1');
    expect(useSceneStore.getState().scene.masks).toEqual({});
  });

  it('removing a node prunes its modifiers’ mask entries', () => {
    nodeWithModifier();
    useSceneStore.getState().setModifierMask('n1', 'm1', maskDef);
    useSceneStore.getState().removeNode('n1');
    expect(useSceneStore.getState().scene.masks).toEqual({});
  });
});

describe('setModifierVectorMask', () => {
  const ref = { appliedTransform2d: IDENTITY_TRANSFORM_2D, featherPx: 4, expand: 0, invert: false };

  function nodesWithVectorAndTwoConsumers() {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          vectorNode('v1'),
          pixelNode('a', { modifiers: [modifier('m1')], dirty: { draft: false, working: false } }),
          pixelNode('b', { modifiers: [modifier('m2')], dirty: { draft: false, working: false } }),
        ],
      },
    }));
  }

  it('stores the ref in maskRefs, points the modifier at it, and dirties both levels', () => {
    nodesWithVectorAndTwoConsumers();
    const maskId = useSceneStore.getState().setModifierVectorMask('a', 'm1', 'v1', ref);

    const scene = useSceneStore.getState().scene;
    expect(scene.maskRefs?.[maskId]).toEqual({ ...ref, id: maskId, nodeId: 'v1' });
    expect(scene.nodes[1].modifiers[0].maskId).toBe(maskId);
    expect(scene.nodes[1].dirty).toEqual({ draft: true, working: true });
    // Baked masks table untouched.
    expect(scene.masks).toBeUndefined();
  });

  it('two modifiers can reference the same vector node with independent feather/invert', () => {
    nodesWithVectorAndTwoConsumers();
    const softId = useSceneStore
      .getState()
      .setModifierVectorMask('a', 'm1', 'v1', { ...ref, featherPx: 10, invert: false });
    const hardInvertedId = useSceneStore
      .getState()
      .setModifierVectorMask('b', 'm2', 'v1', { ...ref, featherPx: 0, invert: true });

    expect(softId).not.toBe(hardInvertedId);
    const scene = useSceneStore.getState().scene;
    expect(scene.maskRefs?.[softId]).toMatchObject({ nodeId: 'v1', featherPx: 10, invert: false });
    expect(scene.maskRefs?.[hardInvertedId]).toMatchObject({
      nodeId: 'v1',
      featherPx: 0,
      invert: true,
    });
  });

  it('replacing a vector mask reuses the same id', () => {
    nodesWithVectorAndTwoConsumers();
    const first = useSceneStore.getState().setModifierVectorMask('a', 'm1', 'v1', ref);
    const second = useSceneStore
      .getState()
      .setModifierVectorMask('a', 'm1', 'v1', { ...ref, featherPx: 20 });

    expect(second).toBe(first);
    expect(useSceneStore.getState().scene.maskRefs?.[first]?.featherPx).toBe(20);
  });

  it('switching a modifier from baked to vector clears the stale masks entry under the same id', () => {
    nodesWithVectorAndTwoConsumers();
    const maskDef = {
      shape: { kind: 'rect' as const, rect: { x: 0, y: 0, w: 10, h: 10 } },
      appliedTransform2d: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      featherPx: 0,
      expand: 0,
      invert: false,
    };
    const id = useSceneStore.getState().setModifierMask('a', 'm1', maskDef);
    useSceneStore.getState().setModifierVectorMask('a', 'm1', 'v1', ref);

    const scene = useSceneStore.getState().scene;
    expect(scene.masks?.[id]).toBeUndefined();
    expect(scene.maskRefs?.[id]).toMatchObject({ nodeId: 'v1' });
  });

  it('removeModifierMask drops a vector ref and prunes the orphaned entry', () => {
    nodesWithVectorAndTwoConsumers();
    useSceneStore.getState().setModifierVectorMask('a', 'm1', 'v1', ref);
    useSceneStore.getState().removeModifierMask('a', 'm1');

    const scene = useSceneStore.getState().scene;
    expect(scene.nodes[1].modifiers[0].maskId).toBeUndefined();
    expect(scene.maskRefs).toEqual({});
  });

  it('deleting the referenced vector node prunes the ref AND clears the dependent maskId', () => {
    nodesWithVectorAndTwoConsumers();
    const maskId = useSceneStore.getState().setModifierVectorMask('a', 'm1', 'v1', ref);
    useSceneStore.getState().removeNode('v1');

    const scene = useSceneStore.getState().scene;
    expect(scene.maskRefs).toEqual({});
    const consumer = scene.nodes.find((n) => n.id === 'a');
    expect(consumer?.modifiers.find((m) => m.id === 'm1')?.maskId).toBeUndefined();
    expect(maskId).toBeTruthy(); // sanity: the id existed before deletion
  });
});

describe('setVectorPaths — cross-node dirty (vector-modifier-masks.md)', () => {
  it('dirties every OTHER node whose modifier references the edited vector node', () => {
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          vectorNode('v1', { dirty: { draft: false, working: false } }),
          pixelNode('a', { modifiers: [modifier('m1')], dirty: { draft: false, working: false } }),
          pixelNode('b', { modifiers: [modifier('m2')], dirty: { draft: false, working: false } }),
          pixelNode('c', { modifiers: [modifier('m3')], dirty: { draft: false, working: false } }),
        ],
      },
    }));
    useSceneStore.getState().setModifierVectorMask('a', 'm1', 'v1', {
      appliedTransform2d: IDENTITY_TRANSFORM_2D,
      featherPx: 0,
      expand: 0,
      invert: false,
    });
    useSceneStore.getState().setModifierVectorMask('b', 'm2', 'v1', {
      appliedTransform2d: IDENTITY_TRANSFORM_2D,
      featherPx: 10,
      expand: 0,
      invert: true,
    });
    // Node 'c' has no reference to v1 — must stay clean.
    for (const id of ['v1', 'a', 'b']) {
      useSceneStore.getState().clearDirty(id, 'draft');
      useSceneStore.getState().clearDirty(id, 'working');
    }

    useSceneStore.getState().setVectorPaths('v1', [
      {
        closed: true,
        anchors: [{ point: { x: 1, y: 1 } }, { point: { x: 9, y: 1 } }, { point: { x: 5, y: 9 } }],
      },
    ]);

    const scene = useSceneStore.getState().scene;
    const byId = Object.fromEntries(scene.nodes.map((n) => [n.id, n]));
    expect(byId.v1.dirty).toEqual({ draft: true, working: true });
    expect(byId.a.dirty).toEqual({ draft: true, working: true });
    expect(byId.b.dirty).toEqual({ draft: true, working: true });
    expect(byId.c.dirty).toEqual({ draft: false, working: false });
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
