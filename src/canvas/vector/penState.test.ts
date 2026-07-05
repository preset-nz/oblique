import { beforeEach, describe, expect, it } from 'vitest';
import * as history from '@/scene/history';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { isVectorNode, type Scene } from '@/scene/types';
import { usePenStateStore } from './penState';

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

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  history.clear();
  useSelectionStore.setState({ selection: { kind: 'none' } });
  usePenStateStore.setState({ anchors: [], cursor: null });
});

describe('pen state store — placing anchors', () => {
  it('placeCorner appends a corner anchor (no handles)', () => {
    usePenStateStore.getState().placeCorner({ x: 1, y: 2 });
    expect(usePenStateStore.getState().anchors).toEqual([{ point: { x: 1, y: 2 } }]);
  });

  it('placeSmooth appends a smooth anchor with handleIn mirrored through handleOut', () => {
    usePenStateStore.getState().placeSmooth({ x: 10, y: 10 }, { x: 20, y: 10 });
    expect(usePenStateStore.getState().anchors).toEqual([
      { point: { x: 10, y: 10 }, handleOut: { x: 20, y: 10 }, handleIn: { x: 0, y: 10 } },
    ]);
  });

  it('accumulates anchors in order across multiple placements', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeSmooth({ x: 10, y: 0 }, { x: 15, y: 5 });
    usePenStateStore.getState().placeCorner({ x: 5, y: 10 });
    expect(usePenStateStore.getState().anchors).toHaveLength(3);
    expect(usePenStateStore.getState().anchors[1].handleIn).toEqual({ x: 5, y: -5 });
  });
});

describe('pen state store — setCursor', () => {
  it('sets and clears the rubber-band cursor', () => {
    usePenStateStore.getState().setCursor({ x: 4, y: 4 });
    expect(usePenStateStore.getState().cursor).toEqual({ x: 4, y: 4 });
    usePenStateStore.getState().setCursor(null);
    expect(usePenStateStore.getState().cursor).toBeNull();
  });
});

describe('pen state store — cancel', () => {
  it('discards anchors/cursor with no scene mutation and no undo step', () => {
    const sceneBefore = useSceneStore.getState().scene;
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeCorner({ x: 10, y: 0 });
    usePenStateStore.getState().setCursor({ x: 5, y: 5 });

    usePenStateStore.getState().cancel();

    expect(usePenStateStore.getState().anchors).toEqual([]);
    expect(usePenStateStore.getState().cursor).toBeNull();
    expect(useSceneStore.getState().scene).toBe(sceneBefore);
    expect(history.canUndo()).toBe(false);
  });
});

describe('pen state store — finishClosed', () => {
  it('no-ops below the 3-anchor threshold', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeCorner({ x: 10, y: 0 });
    usePenStateStore.getState().finishClosed();

    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
    expect(usePenStateStore.getState().anchors).toHaveLength(2);
  });

  it('creates a closed VectorNode from >= 3 anchors, selects it, resets the draft, one history entry', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeSmooth({ x: 10, y: 0 }, { x: 15, y: 5 });
    usePenStateStore.getState().placeCorner({ x: 5, y: 10 });

    usePenStateStore.getState().finishClosed();

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(isVectorNode(node)).toBe(true);
    if (isVectorNode(node)) {
      expect(node.output).toBe('image');
      expect(node.fillRule).toBe('nonzero');
      expect(node.paths).toEqual([
        {
          closed: true,
          anchors: [
            { point: { x: 0, y: 0 } },
            { point: { x: 10, y: 0 }, handleOut: { x: 15, y: 5 }, handleIn: { x: 5, y: -5 } },
            { point: { x: 5, y: 10 } },
          ],
        },
      ]);
    }

    const selection = useSelectionStore.getState().selection;
    expect(selection).toEqual({ kind: 'node', nodeId: node.id });

    expect(usePenStateStore.getState().anchors).toEqual([]);
    expect(usePenStateStore.getState().cursor).toBeNull();
    expect(history.canUndo()).toBe(true);
  });
});

describe('pen state store — finishOpen', () => {
  it('no-ops below 2 anchors', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().finishOpen();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });

  it('creates an open VectorNode from exactly 2 anchors', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeCorner({ x: 10, y: 10 });

    usePenStateStore.getState().finishOpen();

    const node = useSceneStore.getState().scene.nodes[0];
    expect(isVectorNode(node)).toBe(true);
    if (isVectorNode(node)) {
      expect(node.paths[0].closed).toBe(false);
      expect(node.paths[0].anchors).toHaveLength(2);
    }
  });
});

describe('pen state store — finishOnEnter', () => {
  it('closes when >= 3 anchors are placed', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeCorner({ x: 10, y: 0 });
    usePenStateStore.getState().placeCorner({ x: 5, y: 10 });

    usePenStateStore.getState().finishOnEnter();

    const node = useSceneStore.getState().scene.nodes[0];
    expect(isVectorNode(node) && node.paths[0].closed).toBe(true);
  });

  it('finishes open with exactly 2 anchors', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeCorner({ x: 10, y: 0 });

    usePenStateStore.getState().finishOnEnter();

    const node = useSceneStore.getState().scene.nodes[0];
    expect(isVectorNode(node) && node.paths[0].closed).toBe(false);
  });

  it('no-ops with fewer than 2 anchors', () => {
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().finishOnEnter();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });
});
