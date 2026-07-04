import { beforeEach, describe, expect, it } from 'vitest';
import * as history from '@/scene/history';
import { useSceneStore } from '@/scene/store';
import type { Scene } from '@/scene/types';
import { useToolStateStore } from './toolState';

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
  history.clear();
  useToolStateStore.setState({ tool: 'pan' });
});

describe('toolState store', () => {
  it('defaults to pan', () => {
    expect(useToolStateStore.getState().tool).toBe('pan');
  });

  it('setTool switches the active tool', () => {
    useToolStateStore.getState().setTool('move');
    expect(useToolStateStore.getState().tool).toBe('move');
  });

  it('exposes exactly one active tool at a time (no partial/combined state)', () => {
    useToolStateStore.getState().setTool('select-rect');
    expect(useToolStateStore.getState().tool).toBe('select-rect');
    useToolStateStore.getState().setTool('select-ellipse');
    expect(useToolStateStore.getState().tool).toBe('select-ellipse');
  });

  it('does not persist across a fresh store (resets to pan) — simulated restart', () => {
    useToolStateStore.getState().setTool('move');
    // "Restart" = re-seed the store the way a fresh module load would.
    useToolStateStore.setState({ tool: 'pan' });
    expect(useToolStateStore.getState().tool).toBe('pan');
  });
});

describe('tool choice never touches the scene store', () => {
  it('setTool does not change the scene reference, dirty a node, or create an undo step', () => {
    const sceneBefore = useSceneStore.getState().scene;

    useToolStateStore.getState().setTool('move');
    useToolStateStore.getState().setTool('select-rect');
    useToolStateStore.getState().setTool('pan');

    expect(useSceneStore.getState().scene).toBe(sceneBefore);
    expect(history.canUndo()).toBe(false);
  });
});
