import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from './selection';
import { useSceneStore } from './store';
import type { Scene } from './types';

function emptyScene(): Scene {
  return {
    id: 'scene-1',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [0, 0],
  };
}

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useSelectionStore.setState({ selection: { kind: 'none' } });
});

describe('selection store', () => {
  it('defaults to no selection', () => {
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'none' });
  });

  it('selectNode / clear round-trip', () => {
    useSelectionStore.getState().selectNode('node-1');
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: 'node-1' });
    useSelectionStore.getState().clear();
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'none' });
  });
});

describe('de-select never touches the scene store (tool-state.md acceptance)', () => {
  it('selecting and clearing a node does not change the scene reference', () => {
    const sceneBefore = useSceneStore.getState().scene;

    useSelectionStore.getState().selectNode('node-1');
    useSelectionStore.getState().clear();

    expect(useSceneStore.getState().scene).toBe(sceneBefore);
  });
});
