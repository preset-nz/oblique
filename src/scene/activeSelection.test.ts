import { beforeEach, describe, expect, it } from 'vitest';
import { useActiveSelectionStore } from './activeSelection';
import { useSceneStore } from './store';
import type { Scene } from './types';

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

const square = [
  {
    closed: true,
    anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }, { point: { x: 10, y: 10 } }],
  },
];

function addSelection(): string {
  return useSceneStore
    .getState()
    .addVectorNode({ paths: square, fillRule: 'nonzero', role: 'selection', visible: false });
}

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useActiveSelectionStore.getState().clear();
});

describe('useActiveSelectionStore (selections-panel.md)', () => {
  it('starts with nothing active', () => {
    expect(useActiveSelectionStore.getState().id).toBeNull();
  });

  it('activate makes a node the active selection, and a second one replaces it', () => {
    const a = addSelection();
    const b = addSelection();
    useActiveSelectionStore.getState().activate(a);
    expect(useActiveSelectionStore.getState().id).toBe(a);
    useActiveSelectionStore.getState().activate(b);
    expect(useActiveSelectionStore.getState().id).toBe(b);
  });

  it('clear drops it', () => {
    useActiveSelectionStore.getState().activate(addSelection());
    useActiveSelectionStore.getState().clear();
    expect(useActiveSelectionStore.getState().id).toBeNull();
  });

  it('clears itself when its node is deleted, but not for another node', () => {
    const a = addSelection();
    const b = addSelection();
    useActiveSelectionStore.getState().activate(a);
    useSceneStore.getState().removeNode(b);
    expect(useActiveSelectionStore.getState().id).toBe(a);
    useSceneStore.getState().removeNode(a);
    expect(useActiveSelectionStore.getState().id).toBeNull();
  });

  it('survives edits that rebuild the nodes array while the node is still there', () => {
    const a = addSelection();
    useActiveSelectionStore.getState().activate(a);
    useSceneStore.getState().markDirty(a, 'working');
    useSceneStore.getState().setNodeProp(a, { label: 'Sky' });
    expect(useActiveSelectionStore.getState().id).toBe(a);
  });

  it('clears when the scene is replaced (New, Open, undo past its creation)', () => {
    useActiveSelectionStore.getState().activate(addSelection());
    useSceneStore.getState().loadScene(emptyScene());
    expect(useActiveSelectionStore.getState().id).toBeNull();
  });

  it('Edit Shape requests count up, one per request', () => {
    const before = useActiveSelectionStore.getState().shapeEditRequest;
    useActiveSelectionStore.getState().requestShapeEdit();
    useActiveSelectionStore.getState().requestShapeEdit();
    expect(useActiveSelectionStore.getState().shapeEditRequest).toBe(before + 2);
  });
});
