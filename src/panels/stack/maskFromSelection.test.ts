import { beforeEach, describe, expect, it } from 'vitest';
import { useActiveSelectionStore } from '@/scene/activeSelection';
import { DEFAULT_MARQUEE_PARAMS, type MarqueeShape, useMarqueeStateStore } from '@/scene/marquee';
import { useSceneStore } from '@/scene/store';
import { IDENTITY_TRANSFORM_2D, type Scene, type Transform2D } from '@/scene/types';
import { canMaskFromSelection, maskFromSelection } from './maskFromSelection';

const path = [
  {
    closed: true,
    anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 10, y: 10 } }],
  },
];

const rect: MarqueeShape = { kind: 'rect', rect: { x: 1, y: 2, w: 30, h: 40 } };
const moved: Transform2D = { x: 12, y: -3, scaleX: 2, scaleY: 2, rotation: 0.5 };

function emptyScene(): Scene {
  return {
    id: 'scene-1',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [100, 100],
  };
}

/** A consumer layer with a blur on it, and a saved selection; the selection is made active. */
function seed(transform2d?: Transform2D) {
  const store = useSceneStore.getState();
  const layer = store.addVectorNode({
    paths: path,
    fillRule: 'nonzero',
    label: 'Layer',
  });
  // `addVectorNode` doesn't take a transform; move the layer the way the Move tool does.
  if (transform2d) store.setNodeTransform(layer, transform2d);
  const mod = useSceneStore.getState().addModifier(layer, 'gaussian_blur', {});
  const sky = useSceneStore.getState().addVectorNode({
    paths: path,
    fillRule: 'nonzero',
    label: 'Sky',
    role: 'selection',
    visible: false,
  });
  useActiveSelectionStore.getState().activate(sky);
  return { layer, mod, sky };
}

const nodeCount = () => useSceneStore.getState().scene.nodes.length;
const refs = () => Object.values(useSceneStore.getState().scene.maskRefs ?? {});

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useMarqueeStateStore.setState({ marquee: null, params: DEFAULT_MARQUEE_PARAMS });
  useActiveSelectionStore.getState().clear();
});

describe('canMaskFromSelection', () => {
  it('is on for a maskable marquee, or for an active selection with no marquee', () => {
    expect(canMaskFromSelection(rect, null)).toBe(true);
    expect(canMaskFromSelection(null, 'sky')).toBe(true);
    expect(canMaskFromSelection(null, null)).toBe(false);
  });

  it('a marquee that is not finished leaves it off, even with an active selection (its outline is hidden)', () => {
    const lasso: MarqueeShape = { kind: 'lasso', points: [{ x: 0, y: 0 }], closed: false };
    expect(canMaskFromSelection(lasso, 'sky')).toBe(false);
  });
});

describe('maskFromSelection with an active selection (selections-panel.md)', () => {
  it('binds the active selection directly: no node added, node-pinned, with the toolbar values', () => {
    const { layer, mod, sky } = seed(moved);
    useMarqueeStateStore.getState().setParams({ featherPx: 6, expand: 2, invert: true });
    const before = nodeCount();
    expect(maskFromSelection(layer, mod)).toBe('selection');
    expect(nodeCount()).toBe(before);
    const consumer = useSceneStore.getState().scene.nodes.find((n) => n.id === layer);
    const maskId = consumer?.modifiers[0].maskId as string;
    expect(useSceneStore.getState().scene.maskRefs?.[maskId]).toEqual({
      id: maskId,
      nodeId: sky,
      featherPx: 6,
      expand: 2,
      invert: true,
      space: 'node',
      attachTransform: moved,
    });
    // a snapshot, not the consumer's own object
    expect(useSceneStore.getState().scene.maskRefs?.[maskId].attachTransform).not.toBe(
      consumer?.transform2d,
    );
    // nothing consumed: the selection stays active, and the consumer is dirtied for a recook
    expect(useActiveSelectionStore.getState().id).toBe(sky);
    expect(consumer?.dirty).toEqual({ draft: true, working: true });
  });

  it('uses the identity transform for a layer that has none', () => {
    const { layer, mod } = seed();
    maskFromSelection(layer, mod);
    expect(refs()[0].attachTransform).toEqual(IDENTITY_TRANSFORM_2D);
    expect(refs()[0].space).toBe('node');
  });

  it('gives the same mask as the marquee route, for the same values and transform', () => {
    const viaSelection = seed(moved);
    useMarqueeStateStore.getState().setParams({ featherPx: 3, expand: -1, invert: false });
    maskFromSelection(viaSelection.layer, viaSelection.mod);
    const { id: _a, nodeId: _b, ...fromSelection } = refs()[0];

    useSceneStore.setState({ scene: emptyScene() });
    const viaMarquee = seed(moved);
    useActiveSelectionStore.getState().clear();
    useMarqueeStateStore.setState({
      marquee: rect,
      params: { ...DEFAULT_MARQUEE_PARAMS, featherPx: 3, expand: -1, invert: false },
    });
    expect(maskFromSelection(viaMarquee.layer, viaMarquee.mod)).toBe('marquee');
    const { id: _c, nodeId: _d, ...fromMarquee } = refs()[0];
    expect(fromSelection).toEqual(fromMarquee);
  });

  it('a second layer binds the same selection node: the one selection masks both', () => {
    const { layer, mod, sky } = seed();
    const other = useSceneStore
      .getState()
      .addVectorNode({ paths: path, fillRule: 'nonzero', label: 'Other' });
    const otherMod = useSceneStore.getState().addModifier(other, 'gaussian_blur', {});
    maskFromSelection(layer, mod);
    maskFromSelection(other, otherMod);
    expect(refs().map((r) => r.nodeId)).toEqual([sky, sky]);
  });

  it('replacing a mask never deletes the previous source', () => {
    const { layer, mod, sky } = seed();
    const second = useSceneStore.getState().addVectorNode({
      paths: path,
      fillRule: 'nonzero',
      label: 'Selection (rect)',
      role: 'selection',
      visible: false,
    });
    maskFromSelection(layer, mod); // bound to sky
    useActiveSelectionStore.getState().activate(second);
    const before = nodeCount();
    maskFromSelection(layer, mod); // replaced by second; sky has no other user
    expect(nodeCount()).toBe(before);
    expect(useSceneStore.getState().scene.nodes.some((n) => n.id === sky)).toBe(true);
    expect(refs()).toHaveLength(1);
    expect(refs()[0].nodeId).toBe(second);
  });

  it('does nothing on a locked layer', () => {
    const { layer, mod } = seed();
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === layer ? { ...n, state: 'locked' as const } : n)),
      },
    }));
    maskFromSelection(layer, mod);
    expect(refs()).toHaveLength(0);
  });

  it('does nothing without a marquee or an active selection', () => {
    const { layer, mod } = seed();
    useActiveSelectionStore.getState().clear();
    expect(maskFromSelection(layer, mod)).toBeUndefined();
    expect(refs()).toHaveLength(0);
  });
});

describe('a live marquee wins', () => {
  it('makes a new node from the marquee even with an active selection, consumes the marquee, keeps the active one', () => {
    const { layer, mod, sky } = seed();
    useMarqueeStateStore.getState().setMarquee(rect);
    const before = nodeCount();
    expect(maskFromSelection(layer, mod)).toBe('marquee');
    expect(nodeCount()).toBe(before + 1);
    expect(refs()[0].nodeId).not.toBe(sky);
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    expect(useActiveSelectionStore.getState().id).toBe(sky);
  });
});
