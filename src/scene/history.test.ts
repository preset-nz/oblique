import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cache from './cache';
import * as history from './history';
import * as sources from './sources';
import { useSceneStore } from './store';
import type { PixelNode, Scene, SceneNode, VectorNode, VectorPath } from './types';

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
    sourcePath: `/tmp/${id}.png`,
    sourceSize: [100, 100],
    ...overrides,
  };
}

function emptyScene(nodes: SceneNode[] = []): Scene {
  return {
    id: 'scene-1',
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [0, 0],
  };
}

function vectorNode(id: string, overrides: Partial<VectorNode> = {}): VectorNode {
  const paths: VectorPath[] = [
    {
      closed: true,
      anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 5, y: 10 } }],
    },
  ];
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
    paths,
    fillRule: 'nonzero',
    ...overrides,
  };
}

function fakeBitmap(): ImageBitmap {
  return { width: 100, height: 100, close: vi.fn() } as unknown as ImageBitmap;
}

function fakeDeps(): history.HistoryRehydrateDeps {
  return {
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    decode: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
  };
}

beforeEach(() => {
  // Reset the scene FIRST — setState itself fires the module-level subscribe
  // (leftover scene from the previous test differs from a fresh empty one),
  // so history.clear() must run after it to actually leave a clean slate.
  useSceneStore.setState({ scene: emptyScene() });
  cache.clearAll();
  sources.clearAll();
  history.clear();
});

describe('push / undo / redo invariants', () => {
  it('undo restores the scene from before a discrete mutation', () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
    expect(history.canUndo()).toBe(true);

    return history.undo(fakeDeps()).then(() => {
      expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
      expect(history.canUndo()).toBe(false);
      expect(history.canRedo()).toBe(true);
    });
  });

  it('redo re-applies an undone mutation', async () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    await history.undo(fakeDeps());
    await history.redo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  });

  it('a fresh mutation after undo clears the redo stack', async () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    await history.undo(fakeDeps());
    expect(history.canRedo()).toBe(true);

    useSceneStore.getState().addPixelNode({ sourcePath: '/b.png', sourceSize: [10, 10] });
    expect(history.canRedo()).toBe(false);
  });

  it('undo on an empty stack is a no-op', async () => {
    await history.undo(fakeDeps());
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });

  it('redo on an empty stack is a no-op', async () => {
    await history.redo(fakeDeps());
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });

  it('caps the undo stack at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      useSceneStore.getState().addPixelNode({ sourcePath: `/${i}.png`, sourceSize: [10, 10] });
    }
    // Internal cap isn't directly observable, so undo 50 times and expect
    // the 51st to be a no-op (the oldest 10 pushes were evicted).
    return (async () => {
      for (let i = 0; i < 50; i++) {
        await history.undo(fakeDeps());
      }
      expect(history.canUndo()).toBe(false);
      const nodesLeft = useSceneStore.getState().scene.nodes.length;
      expect(nodesLeft).toBe(10); // 60 pushed, only the newest 50 undo steps existed
    })();
  });
});

describe('cook-churn filtering', () => {
  it('does not capture a dirty-only change (markDirty)', () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    history.clear();

    useSceneStore.getState().markDirty('a', 'draft');

    expect(history.canUndo()).toBe(false);
  });

  it('does not capture a dirty-only change (clearDirty)', () => {
    useSceneStore.setState({
      scene: emptyScene([pixelNode('a', { dirty: { draft: true, working: true } })]),
    });
    history.clear();

    useSceneStore.getState().clearDirty('a', 'draft');

    expect(history.canUndo()).toBe(false);
  });

  it('does capture a real edit alongside a dirty flip (setModifierParam)', () => {
    useSceneStore.setState({
      scene: emptyScene([
        pixelNode('a', { modifiers: [{ id: 'm1', type: 'blur', enabled: true, params: {} }] }),
      ]),
    });
    history.clear();

    useSceneStore.getState().setModifierParam('a', 'm1', 'radius', 4);

    expect(history.canUndo()).toBe(true);
  });
});

describe('transaction coalescing', () => {
  it('collapses several mutations between begin/end into one undo step', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a', { opacity: 1 })]) });
    history.clear();

    history.beginTransaction();
    useSceneStore.getState().setNodeProp('a', { opacity: 0.8 });
    useSceneStore.getState().setNodeProp('a', { opacity: 0.6 });
    useSceneStore.getState().setNodeProp('a', { opacity: 0.4 });
    history.endTransaction();

    expect(useSceneStore.getState().scene.nodes[0].opacity).toBe(0.4);

    await history.undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].opacity).toBe(1);
    expect(history.canUndo()).toBe(false); // the three scrub ticks were ONE step
  });

  it('a transaction that produces no net change pushes nothing', () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a', { opacity: 1 })]) });
    history.clear();

    history.beginTransaction();
    history.endTransaction();

    expect(history.canUndo()).toBe(false);
  });

  it('an unmatched beginTransaction self-heals on the next beginTransaction', () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a', { opacity: 1 })]) });
    history.clear();

    history.beginTransaction();
    useSceneStore.getState().setNodeProp('a', { opacity: 0.5 });
    // No endTransaction — simulates a missed pointerup/pointercancel.
    history.beginTransaction();
    useSceneStore.getState().setNodeProp('a', { opacity: 0.2 });
    history.endTransaction();

    // The first (unflushed) drag should have been flushed as its own step
    // by the second beginTransaction's self-heal, so there are two steps.
    expect(history.canUndo()).toBe(true);
  });

  it('undo/redo themselves flush any open transaction first', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a', { opacity: 1 })]) });
    history.clear();

    history.beginTransaction();
    useSceneStore.getState().setNodeProp('a', { opacity: 0.5 });
    // Undo called mid-drag (e.g. Cmd+Z fired while a scrub is still "open").
    await history.undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].opacity).toBe(1);
  });
});

describe('dirty-diff correctness on restore', () => {
  it('marks a node dirty when its modifiers changed between old and restored', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    history.clear();

    useSceneStore.getState().addModifier('a', 'blur', { radius: 2 });
    // addModifier already dirties per the store's own rule; clear it to
    // isolate what undo/redo computes independently.
    useSceneStore.getState().clearDirty('a', 'draft');
    useSceneStore.getState().clearDirty('a', 'working');

    await history.undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].modifiers).toHaveLength(0);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it('leaves a node clean when only compositing fields changed (opacity)', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a', { opacity: 1 })]) });
    sources.set('a', fakeBitmap());
    history.clear();

    useSceneStore.getState().setNodeProp('a', { opacity: 0.5 });

    await history.undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].opacity).toBe(1);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: false, working: false });
  });

  it('marks a vector node dirty when its paths changed between old and restored (undo of a path edit)', async () => {
    useSceneStore.setState({ scene: emptyScene([vectorNode('v')]) });
    sources.set('v', fakeBitmap());
    history.clear();

    useSceneStore.getState().setVectorPaths('v', [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 20, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ]);
    // setVectorPaths already dirties per the store's own rule; clear it to
    // isolate what undo computes independently, same as the modifiers test.
    useSceneStore.getState().clearDirty('v', 'draft');
    useSceneStore.getState().clearDirty('v', 'working');

    await history.undo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes[0] as VectorNode;
    expect(restored.paths[0].anchors[1].point).toEqual({ x: 10, y: 0 });
    expect(restored.dirty).toEqual({ draft: true, working: true });
  });

  it('marks the CONSUMER dirty when undo changes only a referenced vector node’s paths (vector-modifier-masks)', async () => {
    const consumer = pixelNode('p', {
      modifiers: [{ id: 'mod-1', type: 'blur', enabled: true, params: {} }],
    });
    useSceneStore.setState({ scene: emptyScene([consumer, vectorNode('v')]) });
    sources.set('p', fakeBitmap());
    sources.set('v', fakeBitmap());
    useSceneStore.getState().setModifierVectorMask('p', 'mod-1', 'v', {
      featherPx: 0,
      expand: 0,
      invert: false,
    });
    history.clear();

    useSceneStore.getState().setVectorPaths('v', [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 20, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ]);
    for (const id of ['p', 'v']) {
      useSceneStore.getState().clearDirty(id, 'draft');
      useSceneStore.getState().clearDirty(id, 'working');
    }

    await history.undo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes.find((n) => n.id === 'p');
    // The consumer's own modifiers/maskId are identical on both sides of the
    // undo — only the referenced geometry changed — so this is exactly the
    // resolution-through-maskRefs case cookAffectingChanged must catch.
    expect(restored?.dirty).toEqual({ draft: true, working: true });
  });

  it('marks a vector-masked node dirty when undo changes only its transform2d (document-pinned)', async () => {
    const consumer = pixelNode('p', {
      modifiers: [{ id: 'mod-1', type: 'blur', enabled: true, params: {} }],
    });
    useSceneStore.setState({ scene: emptyScene([consumer, vectorNode('v')]) });
    sources.set('p', fakeBitmap());
    sources.set('v', fakeBitmap());
    useSceneStore.getState().setModifierVectorMask('p', 'mod-1', 'v', {
      featherPx: 0,
      expand: 0,
      invert: false,
    });
    history.clear();

    useSceneStore
      .getState()
      .setNodeTransform('p', { x: 40, y: -5, scaleX: 1, scaleY: 1, rotation: 0 });
    useSceneStore.getState().clearDirty('p', 'draft');
    useSceneStore.getState().clearDirty('p', 'working');

    await history.undo(fakeDeps());

    // For an unmasked node a transform-only undo stays clean (rule 4); for a
    // vector-masked one the transform is a cook input, so undo must recook.
    const restored = useSceneStore.getState().scene.nodes.find((n) => n.id === 'p');
    expect(restored?.transform2d).toBeUndefined();
    expect(restored?.dirty).toEqual({ draft: true, working: true });
  });

  it('leaves a node clean when only visibility/blend/order changed', async () => {
    useSceneStore.setState({
      scene: emptyScene([pixelNode('a'), pixelNode('b')]),
    });
    sources.set('a', fakeBitmap());
    sources.set('b', fakeBitmap());
    history.clear();

    useSceneStore.getState().setNodeProp('a', { visible: false });

    await history.undo(fakeDeps());

    const a = useSceneStore.getState().scene.nodes.find((n) => n.id === 'a');
    expect(a?.visible).toBe(true);
    expect(a?.dirty).toEqual({ draft: false, working: false });
  });
});

describe('lock/unlock reconciliation (lock-state-machine.md)', () => {
  it('undo across a lock drops the baked cache and dirties both levels', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    history.clear();

    // Simulate a completed lockNode: commit state: 'locked' as the store
    // action would, with a baked bitmap already in the cache.
    cache.set('a', 'baked', fakeBitmap());
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === 'a' ? { ...n, state: 'locked' as const } : n)),
      },
    }));

    await history.undo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes[0];
    expect(restored.state).toBe('active');
    expect(restored.dirty).toEqual({ draft: true, working: true });
    expect(cache.get('a', 'baked')).toBeUndefined();
  });

  it('redo re-locks without setting any dirty flag (rehydrate is the scheduler’s job, not history’s)', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    history.clear();

    cache.set('a', 'baked', fakeBitmap());
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === 'a' ? { ...n, state: 'locked' as const } : n)),
      },
    }));

    await history.undo(fakeDeps());
    expect(useSceneStore.getState().scene.nodes[0].state).toBe('active');

    await history.redo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes[0];
    expect(restored.state).toBe('locked');
    expect(restored.dirty).toEqual({ draft: false, working: false });
  });

  it('unlockNode itself is captured as an undoable step, reconciled the same way', async () => {
    useSceneStore.setState({
      scene: emptyScene([
        pixelNode('a', { state: 'locked', dirty: { draft: false, working: false } }),
      ]),
    });
    sources.set('a', fakeBitmap());
    cache.set('a', 'baked', fakeBitmap());
    history.clear();

    useSceneStore.getState().unlockNode('a');
    expect(history.canUndo()).toBe(true);

    await history.undo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes[0];
    expect(restored.state).toBe('locked');
    expect(restored.dirty).toEqual({ draft: false, working: false });
  });
});

describe('undo-of-delete rehydration', () => {
  it('re-decodes the evicted source bitmap and marks the restored node dirty', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    cache.set('a', 'draft', fakeBitmap());
    history.clear();

    // Mirrors scene/deleteNode.ts: remove the scene node, evict cache + source.
    useSceneStore.getState().removeNode('a');
    cache.clearNode('a');
    sources.remove('a');

    expect(sources.get('a')).toBeUndefined();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);

    const deps = fakeDeps();
    await history.undo(deps);

    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
    expect(deps.readFile).toHaveBeenCalledWith('/tmp/a.png');
    expect(sources.get('a')).toBeDefined();
  });

  it('flags source-missing instead of throwing when re-decode fails', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    history.clear();

    useSceneStore.getState().removeNode('a');
    sources.remove('a');

    const deps: history.HistoryRehydrateDeps = {
      readFile: vi.fn(async () => {
        throw new Error('file gone');
      }),
      decode: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
    };

    await history.undo(deps);

    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
    expect(sources.isSourceMissing('a')).toBe(true);
  });

  it('undo-of-add evicts the cache and source of the node being removed', async () => {
    useSceneStore.setState({ scene: emptyScene([]) });
    history.clear();

    const nodeId = useSceneStore
      .getState()
      .addPixelNode({ sourcePath: '/new.png', sourceSize: [10, 10] });
    sources.set(nodeId, fakeBitmap());
    cache.set(nodeId, 'draft', fakeBitmap());

    await history.undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
    expect(sources.get(nodeId)).toBeUndefined();
    expect(cache.get(nodeId, 'draft')).toBeUndefined();
  });
});

describe('clear()', () => {
  it('empties both stacks and drops any open transaction', () => {
    useSceneStore.getState().addPixelNode({ sourcePath: '/a.png', sourceSize: [10, 10] });
    history.beginTransaction();

    history.clear();

    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});

describe('text nodes', () => {
  const font = {
    family: 'Helvetica',
    style: 'Regular',
    postscriptName: 'Helvetica',
    weight: 400,
    italic: false,
    category: 'sans' as const,
  };

  it('undoing a setTextProps content change marks the node dirty', async () => {
    const id = useSceneStore
      .getState()
      .addTextNode({ content: 'A', font, position: { x: 0, y: 0 } });
    useSceneStore.getState().clearDirty(id, 'draft');
    useSceneStore.getState().clearDirty(id, 'working');
    useSceneStore.getState().setTextProps(id, { content: 'B' });
    useSceneStore.getState().clearDirty(id, 'draft');
    useSceneStore.getState().clearDirty(id, 'working');

    await history.undo(fakeDeps());

    const node = useSceneStore.getState().scene.nodes.find((n) => n.id === id);
    expect(node).toMatchObject({ content: 'A', dirty: { draft: true, working: true } });
  });

  it('undoing a pure compositing change (opacity) leaves a text node clean', async () => {
    const id = useSceneStore
      .getState()
      .addTextNode({ content: 'A', font, position: { x: 0, y: 0 } });
    useSceneStore.getState().clearDirty(id, 'draft');
    useSceneStore.getState().clearDirty(id, 'working');
    useSceneStore.getState().setNodeProp(id, { opacity: 0.5 });

    await history.undo(fakeDeps());

    const node = useSceneStore.getState().scene.nodes.find((n) => n.id === id);
    expect(node?.dirty).toEqual({ draft: false, working: false });
  });
});

describe('a text node as a modifier-mask target', () => {
  const font = {
    family: 'Helvetica',
    style: 'Regular',
    postscriptName: 'Helvetica',
    weight: 400,
    italic: false,
    category: 'sans' as const,
  };
  const nodeById = (id: string) => useSceneStore.getState().scene.nodes.find((n) => n.id === id);
  const settle = (id: string) => {
    useSceneStore.getState().clearDirty(id, 'draft');
    useSceneStore.getState().clearDirty(id, 'working');
  };

  function setup() {
    const st = useSceneStore.getState();
    const textId = st.addTextNode({ content: 'ROT', font, position: { x: 0, y: 0 } });
    const consumerId = st.addPixelNode({ sourcePath: '/c.png', sourceSize: [10, 10] });
    sources.set(consumerId, fakeBitmap());
    st.addModifier(consumerId, 'grain', {});
    const modId = (nodeById(consumerId) as PixelNode).modifiers[0].id;
    st.setModifierVectorMask(consumerId, modId, textId, { featherPx: 0, expand: 0, invert: false });
    settle(textId);
    settle(consumerId);
    return { textId, consumerId };
  }

  it('undoing a text content change recooks the consumer too', async () => {
    const { textId, consumerId } = setup();
    useSceneStore.getState().setTextProps(textId, { content: 'ROTTEN' });
    settle(textId);
    settle(consumerId);

    await history.undo(fakeDeps());

    expect(nodeById(textId)).toMatchObject({
      content: 'ROT',
      dirty: { draft: true, working: true },
    });
    expect(nodeById(consumerId)?.dirty).toEqual({ draft: true, working: true });
  });

  it('undoing a move of the text node recooks the consumer', async () => {
    const { textId, consumerId } = setup();
    useSceneStore.getState().setTextProps(textId, { position: { x: 50, y: 50 } });
    settle(textId);
    settle(consumerId);

    await history.undo(fakeDeps());

    expect(nodeById(consumerId)?.dirty).toEqual({ draft: true, working: true });
  });

  it('undoing a fill-only change leaves the consumer clean (glyph fill only)', async () => {
    const { textId, consumerId } = setup();
    useSceneStore.getState().setTextProps(textId, { fill: '#ff0000' });
    settle(textId);
    settle(consumerId);

    await history.undo(fakeDeps());

    expect(nodeById(textId)?.dirty).toEqual({ draft: true, working: true });
    expect(nodeById(consumerId)?.dirty).toEqual({ draft: false, working: false });
  });

  it('undoing the text deletion restores the node and the mask ref', async () => {
    const { textId, consumerId } = setup();
    const maskId = (nodeById(consumerId) as PixelNode).modifiers[0].maskId as string;
    history.clear();
    useSceneStore.getState().removeNode(textId);
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]).toBeUndefined();

    await history.undo(fakeDeps());

    expect(nodeById(textId)).toBeDefined();
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]).toMatchObject({ nodeId: textId });
    expect((nodeById(consumerId) as PixelNode).modifiers[0].maskId).toBe(maskId);
  });
});

describe('mask follows node (mask-follows-node.md)', () => {
  const base = { featherPx: 0, expand: 0, invert: false };
  const attach = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  const moved = { x: 40, y: -5, scaleX: 1, scaleY: 1, rotation: 0 };

  function maskedConsumer() {
    const consumer = pixelNode('p', {
      modifiers: [{ id: 'mod-1', type: 'blur', enabled: true, params: {} }],
    });
    useSceneStore.setState({ scene: emptyScene([consumer, vectorNode('v')]) });
    sources.set('p', fakeBitmap());
    sources.set('v', fakeBitmap());
  }

  it('toggling Follows layer on then off is two undo steps', async () => {
    maskedConsumer();
    useSceneStore.getState().setModifierVectorMask('p', 'mod-1', 'v', base);
    history.clear();

    useSceneStore.getState().setMaskSpace('p', 'mod-1', 'node');
    useSceneStore.getState().setMaskSpace('p', 'mod-1', 'document');
    const maskId = useSceneStore.getState().scene.nodes[0].modifiers[0].maskId as string;

    await history.undo(fakeDeps());
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]?.space).toBe('node');
    await history.undo(fakeDeps());
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]?.space).toBeUndefined();
    await history.undo(fakeDeps()); // nothing left
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]?.space).toBeUndefined();
  });

  it('undoing a space switch dirties the consumer (the ref is a cook input)', async () => {
    maskedConsumer();
    useSceneStore.getState().setModifierVectorMask('p', 'mod-1', 'v', base);
    history.clear();
    useSceneStore.getState().setMaskSpace('p', 'mod-1', 'node');
    useSceneStore.getState().clearDirty('p', 'draft');
    useSceneStore.getState().clearDirty('p', 'working');

    await history.undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it('a transform-only undo leaves a node-pinned consumer clean', async () => {
    maskedConsumer();
    useSceneStore.getState().setModifierVectorMask('p', 'mod-1', 'v', {
      ...base,
      space: 'node',
      attachTransform: attach,
    });
    history.clear();
    useSceneStore.getState().setNodeTransform('p', moved);
    useSceneStore.getState().clearDirty('p', 'draft');
    useSceneStore.getState().clearDirty('p', 'working');

    await history.undo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes.find((n) => n.id === 'p');
    expect(restored?.transform2d).toBeUndefined();
    expect(restored?.dirty).toEqual({ draft: false, working: false });
  });
});
