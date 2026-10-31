import { beforeEach, describe, expect, it } from 'vitest';
import { useActiveSelectionStore } from '@/scene/activeSelection';
import { deleteNode } from '@/scene/deleteNode';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import {
  editSelectionShape,
  effectsCount,
  effectsLabel,
  selectionNodes,
  toggleActiveSelection,
} from './SelectionsPanel';

const path = [
  {
    closed: true,
    anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 10, y: 10 } }],
  },
];

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

/** A pixel-less scene: two layers (vector, with one blur each), and selections made through the store. */
function seed() {
  const store = useSceneStore.getState();
  const layerA = store.addVectorNode({ paths: path, fillRule: 'nonzero', label: 'Layer A' });
  const layerB = store.addVectorNode({ paths: path, fillRule: 'nonzero', label: 'Layer B' });
  const modA = useSceneStore.getState().addModifier(layerA, 'gaussian_blur', {});
  const modB = useSceneStore.getState().addModifier(layerB, 'gaussian_blur', {});
  const sky = store.addVectorNode({
    paths: path,
    fillRule: 'nonzero',
    label: 'Sky',
    role: 'selection',
    visible: false,
  });
  // A selection from before the role: recognised by its label.
  const legacy = store.addVectorNode({
    paths: path,
    fillRule: 'nonzero',
    label: 'Selection (rect)',
    visible: false,
  });
  return { layerA, layerB, modA, modB, sky, legacy };
}

const maskParams = { featherPx: 0, expand: 0, invert: false };

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useActiveSelectionStore.getState().clear();
  useSelectionStore.getState().clear();
});

describe('selectionNodes', () => {
  it('lists only selection nodes, in stack order', () => {
    const { sky, legacy } = seed();
    const listed = selectionNodes(useSceneStore.getState().scene).map((n) => n.id);
    expect(listed).toEqual([legacy, sky]); // addVectorNode puts each new node on top
  });

  it('is empty when there are none (the empty state)', () => {
    const store = useSceneStore.getState();
    store.addVectorNode({ paths: path, fillRule: 'nonzero', label: 'Plain shape' });
    expect(selectionNodes(useSceneStore.getState().scene)).toEqual([]);
  });
});

describe('toggleActiveSelection', () => {
  it('a click activates, a second click on the active row clears, another row replaces', () => {
    const { sky, legacy } = seed();
    toggleActiveSelection(sky);
    expect(useActiveSelectionStore.getState().id).toBe(sky);
    toggleActiveSelection(legacy);
    expect(useActiveSelectionStore.getState().id).toBe(legacy);
    toggleActiveSelection(legacy);
    expect(useActiveSelectionStore.getState().id).toBeNull();
  });
});

describe('effectsCount and effectsLabel', () => {
  it('counts the modifiers a selection masks, across layers', () => {
    const { layerA, layerB, modA, modB, sky, legacy } = seed();
    const store = useSceneStore.getState();
    expect(effectsCount(useSceneStore.getState().scene, sky)).toBe(0);
    store.setModifierVectorMask(layerA, modA, sky, maskParams);
    expect(effectsCount(useSceneStore.getState().scene, sky)).toBe(1);
    store.setModifierVectorMask(layerB, modB, sky, maskParams);
    expect(effectsCount(useSceneStore.getState().scene, sky)).toBe(2);
    expect(effectsCount(useSceneStore.getState().scene, legacy)).toBe(0);
  });

  it('counts a modifier once, and not again after the mask moves to another selection', () => {
    const { layerA, modA, sky, legacy } = seed();
    const store = useSceneStore.getState();
    store.setModifierVectorMask(layerA, modA, sky, maskParams);
    store.setModifierVectorMask(layerA, modA, legacy, maskParams);
    expect(effectsCount(useSceneStore.getState().scene, sky)).toBe(0);
    expect(effectsCount(useSceneStore.getState().scene, legacy)).toBe(1);
  });

  it('reads "1 effect" and "2 effects", and nothing for none', () => {
    expect(effectsLabel(0)).toBe('');
    expect(effectsLabel(1)).toBe('1 effect');
    expect(effectsLabel(2)).toBe('2 effects');
  });
});

describe('deleting a selection from its row', () => {
  it('unmasks the modifiers that used it and clears it as the active selection', () => {
    const { layerA, modA, sky } = seed();
    useSceneStore.getState().setModifierVectorMask(layerA, modA, sky, maskParams);
    toggleActiveSelection(sky);
    deleteNode(sky);
    const scene = useSceneStore.getState().scene;
    expect(selectionNodes(scene).map((n) => n.id)).not.toContain(sky);
    expect(scene.nodes.find((n) => n.id === layerA)?.modifiers[0].maskId).toBeUndefined();
    expect(useActiveSelectionStore.getState().id).toBeNull();
  });
});

describe('editSelectionShape', () => {
  it('selects the node, activates it and asks for the Move tool', () => {
    const { sky } = seed();
    const before = useActiveSelectionStore.getState().shapeEditRequest;
    editSelectionShape(sky);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: sky });
    expect(useActiveSelectionStore.getState().id).toBe(sky);
    expect(useActiveSelectionStore.getState().shapeEditRequest).toBe(before + 1);
  });
});
