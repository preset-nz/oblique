/**
 * Layer as driver (Epic 17 story 6, layer-as-driver.md): the store's side. A pixel layer
 * drives a modifier's mask on another layer; the consumer is dirty whenever its driver is,
 * never the reverse; cycles are refused; deleting the driver prunes the mask.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dependsOnLayer, driverRefusal, pixelDriversOf, resolvedMaskInput } from './maskInputs';
import { useSceneStore, withDriverDirty } from './store';
import type { Modifier, PixelMaskRef, PixelNode, Scene, SceneNode, VectorNode } from './types';

const CLEAN = { draft: false, working: false };
const DIRTY = { draft: true, working: true };

function pixel(id: string, overrides: Partial<PixelNode> = {}): PixelNode {
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
    dirty: CLEAN,
    sourcePath: `/tmp/${id}.png`,
    sourceSize: [100, 80],
    ...overrides,
  };
}

function blur(id: string, maskId?: string): Modifier {
  return { id, type: 'gaussian_blur', enabled: true, params: { radius: 4 }, maskId };
}

function driven(id: string, nodeId: string, overrides: Partial<PixelMaskRef> = {}): PixelMaskRef {
  return {
    id,
    kind: 'pixel',
    nodeId,
    channel: 'luminance',
    low: 0,
    high: 1,
    invert: false,
    ...overrides,
  };
}

function scene(nodes: SceneNode[], maskRefs: Scene['maskRefs'] = {}): Scene {
  return {
    id: 'scene-1',
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [100, 80],
    maskRefs,
  };
}

/** Photo `photo` with a blur `m1` driven by `depth`, which has a blur `dm` of its own. */
function drivenScene(): Scene {
  return scene(
    [
      pixel('depth', { modifiers: [blur('dm')] }),
      pixel('photo', { modifiers: [blur('m1', 'm1')] }),
    ],
    { m1: driven('m1', 'depth') },
  );
}

const state = () => useSceneStore.getState();
const node = (id: string) => state().scene.nodes.find((n) => n.id === id);

beforeEach(() => {
  useSceneStore.setState({ scene: scene([]), bakingNodeIds: new Set() });
});

describe('the driver graph', () => {
  const s = drivenScene();
  const getNode = (id: string) => s.nodes.find((n) => n.id === id);
  const getRef = (id: string) => s.maskRefs?.[id];

  it('names the drivers a layer reads and follows them', () => {
    expect(pixelDriversOf(getNode('photo') as SceneNode, getRef)).toEqual(['depth']);
    expect(pixelDriversOf(getNode('depth') as SceneNode, getRef)).toEqual([]);
    expect(dependsOnLayer('photo', 'depth', getNode, getRef)).toBe(true);
    expect(dependsOnLayer('depth', 'photo', getNode, getRef)).toBe(false);
  });

  it('refuses a layer driving itself or a layer that depends on it, with a reason', () => {
    expect(driverRefusal('photo', 'depth', getNode, getRef)).toBeNull();
    expect(driverRefusal('photo', 'photo', getNode, getRef)).toMatch(/its own modifiers/);
    expect(driverRefusal('depth', 'photo', getNode, getRef)).toMatch(
      /“photo” already takes a mask from this layer/,
    );
    const v: VectorNode = {
      ...pixel('v'),
      type: 'vector',
      paths: [],
      fillRule: 'nonzero',
    } as unknown as VectorNode;
    expect(driverRefusal('photo', v.id, (id) => (id === 'v' ? v : getNode(id)), getRef)).toMatch(
      /Only a pixel layer/,
    );
  });

  it('follows chains: c driven by photo, photo by depth — depth cannot take from c', () => {
    const chain = scene([...drivenScene().nodes, pixel('c', { modifiers: [blur('cm', 'cm')] })], {
      m1: driven('m1', 'depth'),
      cm: driven('cm', 'photo'),
    });
    const gn = (id: string) => chain.nodes.find((n) => n.id === id);
    const gr = (id: string) => chain.maskRefs?.[id];
    expect(dependsOnLayer('c', 'depth', gn, gr)).toBe(true);
    expect(driverRefusal('depth', 'c', gn, gr)).not.toBeNull();
  });

  it("a driver's own stack, place and raster are the consumer's mask inputs", () => {
    const base = drivenScene();
    const key = (sc: Scene, raster?: string) =>
      JSON.stringify(
        resolvedMaskInput(
          'm1',
          (id) => sc.maskRefs?.[id],
          (id) => sc.nodes.find((n) => n.id === id),
          raster === undefined ? undefined : () => raster,
        ),
      );
    const withDepth = (patch: Partial<PixelNode>) =>
      scene(
        base.nodes.map((n) => (n.id === 'depth' ? { ...n, ...patch } : n)),
        base.maskRefs,
      );
    expect(key(withDepth({ modifiers: [blur('dm'), blur('dm2')] }))).not.toBe(key(base));
    expect(
      key(withDepth({ transform2d: { x: 5, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } })),
    ).not.toBe(key(base));
    expect(key(withDepth({ visible: false }))).toBe(key(base)); // hiding is compositing only
    expect(key(base, 'working:3')).not.toBe(key(base, 'working:4'));
  });
});

describe('withDriverDirty', () => {
  it('dirties a consumer at the levels its driver is dirty, through chains', () => {
    const s = scene(
      [
        pixel('depth', { dirty: { draft: false, working: true } }),
        pixel('photo', { modifiers: [blur('m1', 'm1')] }),
        pixel('c', { modifiers: [blur('cm', 'cm')] }),
      ],
      { m1: driven('m1', 'depth'), cm: driven('cm', 'photo') },
    );
    const out = withDriverDirty(s);
    expect(out.nodes.map((n) => n.dirty)).toEqual([
      { draft: false, working: true },
      { draft: false, working: true },
      { draft: false, working: true },
    ]);
  });

  it('never dirties a driver because of its consumer, nor a locked consumer, and keeps identity when nothing changes', () => {
    const s = scene(
      [
        pixel('depth'),
        pixel('photo', { modifiers: [blur('m1', 'm1')], dirty: DIRTY }),
        pixel('locked', { modifiers: [blur('lm', 'lm')], state: 'locked' }),
      ],
      { m1: driven('m1', 'depth'), lm: driven('lm', 'photo') },
    );
    expect(withDriverDirty(s)).toBe(s);
  });
});

describe('setModifierPixelMask', () => {
  it('attaches a driven ref under the modifier id and dirties the consumer', () => {
    useSceneStore.setState({
      scene: scene([pixel('depth'), pixel('photo', { modifiers: [blur('m1')] })]),
    });
    const id = state().setModifierPixelMask('photo', 'm1', 'depth', {
      channel: 'alpha',
      low: 0.2,
      high: 0.8,
      invert: true,
    });
    expect(id).toBe('m1');
    expect(state().scene.maskRefs?.m1).toEqual(
      driven('m1', 'depth', { channel: 'alpha', low: 0.2, high: 0.8, invert: true }),
    );
    expect(node('photo')?.modifiers[0].maskId).toBe('m1');
    expect(node('photo')?.dirty).toEqual(DIRTY);
    expect(node('depth')?.dirty).toEqual(CLEAN);
  });

  it('refuses a cycle, itself, a locked consumer and a non-pixel driver, changing nothing', () => {
    useSceneStore.setState({ scene: drivenScene() });
    const before = state().scene;
    const numbers = { channel: 'luminance' as const, low: 0, high: 1, invert: false };
    expect(state().setModifierPixelMask('depth', 'dm', 'photo', numbers)).toBeUndefined();
    expect(state().setModifierPixelMask('photo', 'm1', 'photo', numbers)).toBeUndefined();
    expect(state().setModifierPixelMask('photo', 'm1', 'nope', numbers)).toBeUndefined();
    expect(state().scene).toBe(before);
    useSceneStore.setState({
      scene: scene([pixel('depth'), pixel('photo', { modifiers: [blur('m1')], state: 'locked' })]),
    });
    const locked = state().scene;
    expect(state().setModifierPixelMask('photo', 'm1', 'depth', numbers)).toBeUndefined();
    expect(state().scene).toBe(locked);
  });

  it('has no space to switch', () => {
    useSceneStore.setState({ scene: drivenScene() });
    const before = state().scene;
    state().setMaskSpace('photo', 'm1', 'node');
    expect(state().scene).toBe(before);
  });
});

describe('dirty rules for a live driver', () => {
  beforeEach(() => useSceneStore.setState({ scene: drivenScene() }));

  it("editing the driver's own stack dirties the consumer", () => {
    state().setModifierParam('depth', 'dm', 'radius', 9);
    expect(node('depth')?.dirty).toEqual(DIRTY);
    expect(node('photo')?.dirty).toEqual(DIRTY);
  });

  it('editing the consumer never dirties the driver', () => {
    state().setModifierParam('photo', 'm1', 'radius', 9);
    expect(node('photo')?.dirty).toEqual(DIRTY);
    expect(node('depth')?.dirty).toEqual(CLEAN);
  });

  it('moving the driver dirties the consumer; moving the consumer re-samples it too', () => {
    const t = { x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    state().setNodeTransform('depth', t);
    expect(node('photo')?.dirty).toEqual(DIRTY);
    useSceneStore.setState({ scene: drivenScene() });
    state().setNodeTransform('photo', t);
    expect(node('photo')?.dirty).toEqual(DIRTY);
  });

  it('hiding the driver keeps the mask and dirties nothing', () => {
    state().setNodeProp('depth', { visible: false });
    expect(state().scene.maskRefs?.m1).toEqual(driven('m1', 'depth'));
    expect(node('photo')?.dirty).toEqual(CLEAN);
  });

  it("a consumer's flag clearing while its driver is dirty is raised again", () => {
    state().setModifierParam('depth', 'dm', 'radius', 9);
    state().clearDirty('photo', 'draft');
    expect(node('photo')?.dirty.draft).toBe(true);
    state().clearDirty('depth', 'draft');
    state().clearDirty('photo', 'draft');
    expect(node('photo')?.dirty.draft).toBe(false);
  });

  it('deleting the driver prunes the ref and dirties the consumer, which now cooks unmasked', () => {
    state().removeNode('depth');
    expect(state().scene.maskRefs).toEqual({});
    expect(node('photo')?.modifiers[0].maskId).toBeUndefined();
    expect(node('photo')?.dirty).toEqual(DIRTY);
  });

  it('a duplicate of the consumer is driven by the same layer under a fresh ref', () => {
    const copy = state().duplicateNode('photo') as string;
    const maskId = node(copy)?.modifiers[0].maskId as string;
    expect(maskId).not.toBe('m1');
    expect(state().scene.maskRefs?.[maskId]).toEqual(driven(maskId, 'depth'));
  });
});
