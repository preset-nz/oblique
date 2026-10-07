import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as backgroundSource from './backgroundSource';
import * as cache from './cache';
import { type HistoryRehydrateDeps, restoreScene } from './restore';
import { sceneChangedIgnoringDirty } from './sceneDiff';
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

function fakeDeps(): HistoryRehydrateDeps {
  return {
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    decode: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
  };
}

/**
 * `restoreScene` is what rhizome's mirror uses for undo, redo and open (Epic 22 removed the
 * snapshot history that used to drive it from the store). These tests keep what that history's
 * tests proved about it: dirty flags recomputed from an old-vs-new diff, caches dropped and
 * bitmaps re-decoded. A tiny snapshot undo stands in for rhizome here: it remembers the scene
 * before each real edit and restores it the way the mirror does. It is test code only.
 */
const undoStack: Scene[] = [];
const redoStack: Scene[] = [];
let applying = false;

useSceneStore.subscribe((state, prev) => {
  if (applying || state.scene === prev.scene) return;
  if (!sceneChangedIgnoringDirty(prev.scene, state.scene)) return; // cook churn is not an edit
  undoStack.push(prev.scene);
  redoStack.length = 0;
});

function reset(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

const canUndo = (): boolean => undoStack.length > 0;

async function step(from: Scene[], to: Scene[], deps: HistoryRehydrateDeps): Promise<void> {
  const target = from.pop();
  if (!target) return;
  const current = useSceneStore.getState().scene;
  to.push(current);
  await restoreScene(current, target, deps, (scene) => {
    applying = true;
    try {
      useSceneStore.getState().loadScene(scene);
    } finally {
      applying = false;
    }
  });
}

const undo = (deps: HistoryRehydrateDeps) => step(undoStack, redoStack, deps);
const redo = (deps: HistoryRehydrateDeps) => step(redoStack, undoStack, deps);

beforeEach(() => {
  // Reset the scene FIRST — setState itself fires the module-level subscribe
  // (leftover scene from the previous test differs from a fresh empty one),
  // so reset() must run after it to actually leave a clean slate.
  useSceneStore.setState({ scene: emptyScene() });
  cache.clearAll();
  sources.clearAll();
  backgroundSource.clear();
  reset();
});

describe('dirty-diff correctness on restore', () => {
  it('marks a node dirty when its modifiers changed between old and restored', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    reset();

    useSceneStore.getState().addModifier('a', 'blur', { radius: 2 });
    // addModifier already dirties per the store's own rule; clear it to
    // isolate what undo/redo computes independently.
    useSceneStore.getState().clearDirty('a', 'draft');
    useSceneStore.getState().clearDirty('a', 'working');

    await undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].modifiers).toHaveLength(0);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it('leaves a node clean when only compositing fields changed (opacity)', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a', { opacity: 1 })]) });
    sources.set('a', fakeBitmap());
    reset();

    useSceneStore.getState().setNodeProp('a', { opacity: 0.5 });

    await undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].opacity).toBe(1);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: false, working: false });
  });

  it('marks a vector node dirty when its paths changed between old and restored (undo of a path edit)', async () => {
    useSceneStore.setState({ scene: emptyScene([vectorNode('v')]) });
    sources.set('v', fakeBitmap());
    reset();

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

    await undo(fakeDeps());

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
    reset();

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

    await undo(fakeDeps());

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
    reset();

    useSceneStore
      .getState()
      .setNodeTransform('p', { x: 40, y: -5, scaleX: 1, scaleY: 1, rotation: 0 });
    useSceneStore.getState().clearDirty('p', 'draft');
    useSceneStore.getState().clearDirty('p', 'working');

    await undo(fakeDeps());

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
    reset();

    useSceneStore.getState().setNodeProp('a', { visible: false });

    await undo(fakeDeps());

    const a = useSceneStore.getState().scene.nodes.find((n) => n.id === 'a');
    expect(a?.visible).toBe(true);
    expect(a?.dirty).toEqual({ draft: false, working: false });
  });
});

describe('lock/unlock reconciliation (lock-state-machine.md)', () => {
  it('undo across a lock drops the baked cache and dirties both levels', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    reset();

    // Simulate a completed lockNode: commit state: 'locked' as the store
    // action would, with a baked bitmap already in the cache.
    cache.set('a', 'baked', fakeBitmap());
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === 'a' ? { ...n, state: 'locked' as const } : n)),
      },
    }));

    await undo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes[0];
    expect(restored.state).toBe('active');
    expect(restored.dirty).toEqual({ draft: true, working: true });
    expect(cache.get('a', 'baked')).toBeUndefined();
  });

  it('redo re-locks without setting any dirty flag (rehydrate is the scheduler’s job, not restore’s)', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    reset();

    cache.set('a', 'baked', fakeBitmap());
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === 'a' ? { ...n, state: 'locked' as const } : n)),
      },
    }));

    await undo(fakeDeps());
    expect(useSceneStore.getState().scene.nodes[0].state).toBe('active');

    await redo(fakeDeps());

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
    reset();

    useSceneStore.getState().unlockNode('a');
    expect(canUndo()).toBe(true);

    await undo(fakeDeps());

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
    reset();

    // Mirrors scene/deleteNode.ts: remove the scene node, evict cache + source.
    useSceneStore.getState().removeNode('a');
    cache.clearNode('a');
    sources.remove('a');

    expect(sources.get('a')).toBeUndefined();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);

    const deps = fakeDeps();
    await undo(deps);

    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
    expect(deps.readFile).toHaveBeenCalledWith('/tmp/a.png');
    expect(sources.get('a')).toBeDefined();
  });

  it('flags source-missing instead of throwing when re-decode fails', async () => {
    useSceneStore.setState({ scene: emptyScene([pixelNode('a')]) });
    sources.set('a', fakeBitmap());
    reset();

    useSceneStore.getState().removeNode('a');
    sources.remove('a');

    const deps: HistoryRehydrateDeps = {
      readFile: vi.fn(async () => {
        throw new Error('file gone');
      }),
      decode: vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
    };

    await undo(deps);

    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);
    expect(sources.isSourceMissing('a')).toBe(true);
  });

  it('undo-of-add evicts the cache and source of the node being removed', async () => {
    useSceneStore.setState({ scene: emptyScene([]) });
    reset();

    const nodeId = useSceneStore
      .getState()
      .addPixelNode({ sourcePath: '/new.png', sourceSize: [10, 10] });
    sources.set(nodeId, fakeBitmap());
    cache.set(nodeId, 'draft', fakeBitmap());

    await undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
    expect(sources.get(nodeId)).toBeUndefined();
    expect(cache.get(nodeId, 'draft')).toBeUndefined();
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

    await undo(fakeDeps());

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

    await undo(fakeDeps());

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

    await undo(fakeDeps());

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

    await undo(fakeDeps());

    expect(nodeById(consumerId)?.dirty).toEqual({ draft: true, working: true });
  });

  it('undoing a fill-only change leaves the consumer clean (glyph fill only)', async () => {
    const { textId, consumerId } = setup();
    useSceneStore.getState().setTextProps(textId, { fill: '#ff0000' });
    settle(textId);
    settle(consumerId);

    await undo(fakeDeps());

    expect(nodeById(textId)?.dirty).toEqual({ draft: true, working: true });
    expect(nodeById(consumerId)?.dirty).toEqual({ draft: false, working: false });
  });

  it('undoing the text deletion restores the node and the mask ref', async () => {
    const { textId, consumerId } = setup();
    const maskId = (nodeById(consumerId) as PixelNode).modifiers[0].maskId as string;
    reset();
    useSceneStore.getState().removeNode(textId);
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]).toBeUndefined();

    await undo(fakeDeps());

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
    reset();

    useSceneStore.getState().setMaskSpace('p', 'mod-1', 'node');
    useSceneStore.getState().setMaskSpace('p', 'mod-1', 'document');
    const maskId = useSceneStore.getState().scene.nodes[0].modifiers[0].maskId as string;

    await undo(fakeDeps());
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]?.space).toBe('node');
    await undo(fakeDeps());
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]?.space).toBeUndefined();
    await undo(fakeDeps()); // nothing left
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]?.space).toBeUndefined();
  });

  it('undoing a space switch dirties the consumer (the ref is a cook input)', async () => {
    maskedConsumer();
    useSceneStore.getState().setModifierVectorMask('p', 'mod-1', 'v', base);
    reset();
    useSceneStore.getState().setMaskSpace('p', 'mod-1', 'node');
    useSceneStore.getState().clearDirty('p', 'draft');
    useSceneStore.getState().clearDirty('p', 'working');

    await undo(fakeDeps());

    expect(useSceneStore.getState().scene.nodes[0].dirty).toEqual({ draft: true, working: true });
  });

  it('a transform-only undo leaves a node-pinned consumer clean', async () => {
    maskedConsumer();
    useSceneStore.getState().setModifierVectorMask('p', 'mod-1', 'v', {
      ...base,
      space: 'node',
      attachTransform: attach,
    });
    reset();
    useSceneStore.getState().setNodeTransform('p', moved);
    useSceneStore.getState().clearDirty('p', 'draft');
    useSceneStore.getState().clearDirty('p', 'working');

    await undo(fakeDeps());

    const restored = useSceneStore.getState().scene.nodes.find((n) => n.id === 'p');
    expect(restored?.transform2d).toBeUndefined();
    expect(restored?.dirty).toEqual({ draft: false, working: false });
  });
});

describe('undo/redo of the document background image (background-image.md)', () => {
  const setImage = () => {
    // Mirrors io.ts setBackgroundImageFromPath: holder first, then the scene action.
    backgroundSource.set('/bg.png', fakeBitmap());
    useSceneStore.getState().setBackgroundImage('/bg.png', [100, 100]);
  };

  it('undo of "set image" drops the bitmap; redo re-decodes it from the path', async () => {
    setImage();
    expect(backgroundSource.get('/bg.png')).toBeDefined();
    expect(canUndo()).toBe(true);

    await undo(fakeDeps());
    expect(useSceneStore.getState().scene.background).toBeUndefined();
    expect(backgroundSource.heldPath()).toBeUndefined();

    const deps = fakeDeps();
    await redo(deps);
    expect(useSceneStore.getState().scene.background).toEqual({
      type: 'image',
      sourcePath: '/bg.png',
      sourceSize: [100, 100],
    });
    expect(deps.readFile).toHaveBeenCalledWith('/bg.png');
    expect(backgroundSource.get('/bg.png')).toBeDefined();
  });

  it('undo of "image -> colour" re-decodes the image; an unreadable path flags missing instead of throwing', async () => {
    setImage();
    useSceneStore.getState().setBackgroundColor('#112233');
    expect(backgroundSource.heldPath()).toBeUndefined();

    await undo(fakeDeps());
    expect(backgroundSource.get('/bg.png')).toBeDefined();

    await redo(fakeDeps()); // back to colour
    expect(backgroundSource.heldPath()).toBeUndefined();

    const failing = {
      readFile: vi.fn(async () => {
        throw new Error('gone');
      }),
      decode: vi.fn(),
    };
    await undo(failing);
    expect(useSceneStore.getState().scene.background?.type).toBe('image');
    expect(backgroundSource.heldPath()).toBeUndefined();
    expect(backgroundSource.useBackgroundSourceStore.getState().missing).toBe(true);
  });
});
