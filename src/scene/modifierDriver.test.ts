/**
 * A modifier's driver (Epic 27, blur-radius.md): the store's side. A pixel layer sets one of an
 * op's values per pixel; the consumer is dirty whenever the layer is, never the reverse; cycles
 * (through masks and drivers alike) are refused; deleting the layer drops the driver.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { rowsFromScene, sceneFromRows } from '@/rhizome/adapter';
import {
  dependsOnLayer,
  followRefusal,
  hasDocumentPinnedMask,
  pixelDriversOf,
  resolvedDriverInput,
} from './maskInputs';
import { useSceneStore, withDriverDirty } from './store';
import type { Modifier, ModifierDriver, PixelNode, Scene, SceneNode } from './types';

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

function follows(nodeId: string, overrides: Partial<ModifierDriver> = {}): ModifierDriver {
  return {
    kind: 'radius',
    nodeId,
    channel: 'luminance',
    low: 0,
    high: 1,
    invert: true,
    ...overrides,
  };
}

function blur(id: string, driver?: ModifierDriver): Modifier {
  return {
    id,
    type: 'gaussian_blur',
    enabled: true,
    params: { radius: 4 },
    ...(driver ? { driver } : {}),
  };
}

function scene(nodes: SceneNode[]): Scene {
  return {
    id: 'scene-1',
    nodes,
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [100, 80],
    maskRefs: {},
  };
}

/** Photo's blur `m1` follows `depth`, which has a blur `dm` of its own. */
function drivenScene(): Scene {
  return scene([
    pixel('depth', { modifiers: [blur('dm')] }),
    pixel('photo', { modifiers: [blur('m1', follows('depth'))] }),
  ]);
}

const state = () => useSceneStore.getState();
const node = (id: string) => state().scene.nodes.find((n) => n.id === id);
const lookups = (s: Scene) => ({
  getNode: (id: string) => s.nodes.find((n) => n.id === id),
  getRef: (id: string) => s.maskRefs?.[id],
});

describe('the driver graph', () => {
  it('a followed layer is a driver of the consumer, once, in modifier order', () => {
    const s = scene([
      pixel('a'),
      pixel('b'),
      pixel('photo', {
        modifiers: [blur('m1', follows('b')), blur('m2', follows('a')), blur('m3', follows('b'))],
      }),
    ]);
    const { getRef } = lookups(s);
    expect(pixelDriversOf(s.nodes[2], getRef)).toEqual(['b', 'a']);
    expect(pixelDriversOf(s.nodes[0], getRef)).toEqual([]);
  });

  it('a layer depends on what it follows, through chains', () => {
    const s = scene([
      pixel('c'),
      pixel('b', { modifiers: [blur('bm', follows('c'))] }),
      pixel('a', { modifiers: [blur('am', follows('b'))] }),
    ]);
    const { getNode, getRef } = lookups(s);
    expect(dependsOnLayer('a', 'c', getNode, getRef)).toBe(true);
    expect(dependsOnLayer('c', 'a', getNode, getRef)).toBe(false);
  });

  it('followRefusal gives the reason for itself, a cycle and a non-pixel layer, and null otherwise', () => {
    const s = drivenScene();
    const { getNode, getRef } = lookups(s);
    expect(followRefusal('photo', 'depth', getNode, getRef)).toBeNull();
    expect(followRefusal('photo', 'photo', getNode, getRef)).toMatch(/its own modifiers/);
    expect(followRefusal('depth', 'photo', getNode, getRef)).toBe(
      "“photo” already takes its look from “depth”, so “depth” can't follow it.",
    );
    expect(followRefusal('photo', 'nope', getNode, getRef)).toMatch(/pixel layer/);
  });

  it('a driver is always document-pinned, so the consumer reads its own transform', () => {
    const s = drivenScene();
    const { getRef } = lookups(s);
    expect(hasDocumentPinnedMask(s.nodes[1].modifiers, getRef)).toBe(true);
    expect(hasDocumentPinnedMask(s.nodes[0].modifiers, getRef)).toBe(false);
  });

  it("a driver's inputs hold its layer's stack, place, its own drivers and the raster", () => {
    const base = drivenScene();
    const key = (sc: Scene, raster?: string) => {
      const { getNode, getRef } = lookups(sc);
      return JSON.stringify(
        resolvedDriverInput(
          sc.nodes.find((n) => n.id === 'photo')?.modifiers[0].driver,
          getRef,
          getNode,
          raster === undefined ? undefined : () => raster,
        ),
      );
    };
    const withDepth = (patch: Partial<PixelNode>) =>
      scene(base.nodes.map((n) => (n.id === 'depth' ? { ...n, ...patch } : n)));
    expect(
      resolvedDriverInput(
        undefined,
        () => undefined,
        () => undefined,
      ),
    ).toBeNull();
    expect(key(withDepth({ modifiers: [blur('dm'), blur('dm2')] }))).not.toBe(key(base));
    expect(
      key(withDepth({ transform2d: { x: 5, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } })),
    ).not.toBe(key(base));
    expect(key(withDepth({ visible: false }))).toBe(key(base));
    expect(key(base, 'working:3')).not.toBe(key(base, 'working:4'));
    // depth's own blur now follows a third layer: that is an input of Photo's too
    expect(key(withDepth({ modifiers: [blur('dm', follows('far'))] }))).not.toBe(key(base));
    expect(key(withDepth({ modifiers: [blur('dm', follows('far'))] }))).not.toBe(
      key(withDepth({ modifiers: [blur('dm', follows('far', { low: 0.4 }))] })),
    );
  });
});

describe('withDriverDirty with a modifier driver', () => {
  it('dirties a consumer at the levels its layer is dirty, and only then', () => {
    const s = scene([
      pixel('depth', { dirty: { draft: false, working: true } }),
      pixel('photo', { modifiers: [blur('m1', follows('depth'))] }),
    ]);
    expect(withDriverDirty(s).nodes.map((n) => n.dirty)).toEqual([
      { draft: false, working: true },
      { draft: false, working: true },
    ]);
    const calm = scene([
      pixel('depth'),
      pixel('photo', { modifiers: [blur('m1', follows('depth'))] }),
    ]);
    expect(withDriverDirty(calm)).toBe(calm);
  });
});

describe('setModifierDriver', () => {
  beforeEach(() =>
    useSceneStore.setState({
      scene: scene([pixel('depth'), pixel('photo', { modifiers: [blur('m1')] })]),
    }),
  );

  it('binds the layer with its numbers and dirties the consumer, not the layer', () => {
    expect(
      state().setModifierDriver('photo', 'm1', 'depth', {
        kind: 'radius',
        channel: 'alpha',
        low: 0.2,
        high: 0.8,
        invert: false,
      }),
    ).toBe(true);
    expect(node('photo')?.modifiers[0].driver).toEqual(
      follows('depth', { channel: 'alpha', low: 0.2, high: 0.8, invert: false }),
    );
    expect(node('photo')?.modifiers[0].maskId).toBeUndefined();
    expect(node('photo')?.dirty).toEqual(DIRTY);
    expect(node('depth')?.dirty).toEqual(CLEAN);
  });

  it('refuses a cycle, itself, a missing layer and a locked consumer, changing nothing', () => {
    useSceneStore.setState({ scene: drivenScene() });
    const before = state().scene;
    const numbers = {
      kind: 'radius',
      channel: 'luminance' as const,
      low: 0,
      high: 1,
      invert: false,
    };
    expect(state().setModifierDriver('depth', 'dm', 'photo', numbers)).toBe(false);
    expect(state().setModifierDriver('photo', 'm1', 'photo', numbers)).toBe(false);
    expect(state().setModifierDriver('photo', 'm1', 'nope', numbers)).toBe(false);
    expect(state().scene).toBe(before);
    useSceneStore.setState({
      scene: scene([pixel('depth'), pixel('photo', { modifiers: [blur('m1')], state: 'locked' })]),
    });
    const locked = state().scene;
    expect(state().setModifierDriver('photo', 'm1', 'depth', numbers)).toBe(false);
    expect(state().scene).toBe(locked);
  });

  it('removeModifierDriver takes it off, dirties, and does nothing when there is none', () => {
    const plain = state().scene;
    state().removeModifierDriver('photo', 'm1');
    expect(state().scene).toBe(plain);
    useSceneStore.setState({ scene: drivenScene() });
    state().removeModifierDriver('photo', 'm1');
    expect('driver' in (node('photo')?.modifiers[0] ?? {})).toBe(false);
    expect(node('photo')?.dirty).toEqual(DIRTY);
    expect(node('depth')?.modifiers).toHaveLength(1);
  });
});

describe('dirty rules for a followed layer', () => {
  beforeEach(() => useSceneStore.setState({ scene: drivenScene() }));

  it("editing the layer's own stack dirties the consumer; the reverse never does", () => {
    state().setModifierParam('photo', 'm1', 'radius', 9);
    expect(node('depth')?.dirty).toEqual(CLEAN);
    state().setModifierParam('depth', 'dm', 'radius', 9);
    expect(node('photo')?.dirty).toEqual(DIRTY);
  });

  it('moving the layer recooks the consumer; so does moving the consumer (it re-samples)', () => {
    const t = { x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    state().setNodeTransform('depth', t);
    expect(node('photo')?.dirty).toEqual(DIRTY);
    useSceneStore.setState({ scene: drivenScene() });
    state().setNodeTransform('photo', t);
    expect(node('photo')?.dirty).toEqual(DIRTY);
  });

  it('hiding the layer keeps the driver and dirties nothing', () => {
    state().setNodeProp('depth', { visible: false });
    expect(node('photo')?.modifiers[0].driver).toEqual(follows('depth'));
    expect(node('photo')?.dirty).toEqual(CLEAN);
  });

  it('deleting the layer drops the driver and dirties the consumer, which now cooks undriven', () => {
    state().removeNode('depth');
    expect('driver' in (node('photo')?.modifiers[0] ?? {})).toBe(false);
    expect(node('photo')?.dirty).toEqual(DIRTY);
  });

  it('a duplicate of the consumer follows the same layer with its own copy of the numbers', () => {
    const copy = state().duplicateNode('photo') as string;
    const d = node(copy)?.modifiers[0].driver;
    expect(d).toEqual(follows('depth'));
    expect(d).not.toBe(node('photo')?.modifiers[0].driver);
  });
});

describe('the driver in the tree', () => {
  it('survives scene to rows and back, beside a mask', () => {
    const s = drivenScene();
    s.nodes[1].modifiers[0].maskId = 'm1';
    s.maskRefs = {
      m1: {
        id: 'm1',
        kind: 'pixel',
        nodeId: 'depth',
        channel: 'alpha',
        low: 0.1,
        high: 0.9,
        invert: false,
      },
    };
    const back = sceneFromRows(rowsFromScene(s));
    expect(back?.nodes[1].modifiers[0].driver).toEqual(follows('depth'));
    expect(back?.nodes[1].modifiers[0].maskId).toBe('m1');
    expect(back?.maskRefs?.m1).toMatchObject({ nodeId: 'depth', channel: 'alpha' });
    expect(back?.nodes[0].modifiers[0].driver).toBeUndefined();
  });

  it('a driver binding\'s `refId: ""` (Rust declares it on the slot) is not read into the driver', () => {
    const rows = rowsFromScene(drivenScene());
    const mod = [...rows.values()].find((r) => r.name === 'm1');
    const binding = mod?.bindings?.[0];
    if (binding?.values) binding.values.refId = '';
    expect(sceneFromRows(rows)?.nodes[1].modifiers[0].driver).toEqual(follows('depth'));
  });
});
