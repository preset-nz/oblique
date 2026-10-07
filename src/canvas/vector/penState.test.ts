import { beforeEach, describe, expect, it } from 'vitest';
import { usePathEditStateStore } from '@/scene/pathEditState';
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

function drawTriangleAndFinish(offset = 0): void {
  usePenStateStore.getState().placeCorner({ x: 0 + offset, y: 0 });
  usePenStateStore.getState().placeCorner({ x: 10 + offset, y: 0 });
  usePenStateStore.getState().placeCorner({ x: 5 + offset, y: 10 });
  usePenStateStore.getState().finishClosed();
}

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useSelectionStore.setState({ selection: { kind: 'none' } });
  usePenStateStore.setState({ anchors: [], cursor: null });
  usePathEditStateStore.setState({ activeAnchor: null });
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
  it('discards anchors/cursor with no scene mutation', () => {
    const sceneBefore = useSceneStore.getState().scene;
    usePenStateStore.getState().placeCorner({ x: 0, y: 0 });
    usePenStateStore.getState().placeCorner({ x: 10, y: 0 });
    usePenStateStore.getState().setCursor({ x: 5, y: 5 });

    usePenStateStore.getState().cancel();

    expect(usePenStateStore.getState().anchors).toEqual([]);
    expect(usePenStateStore.getState().cursor).toBeNull();
    expect(useSceneStore.getState().scene).toBe(sceneBefore);
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

  it('creates a closed VectorNode from >= 3 anchors, selects it, resets the draft', () => {
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

describe('pen state store — commit-target rule (pen-append-to-node.md)', () => {
  it('with a vector node selected: appends a path to it, keeps it selected, focuses the new path', () => {
    drawTriangleAndFinish();
    const nodeId = useSceneStore.getState().scene.nodes[0].id;
    expect(useSceneStore.getState().scene.nodes).toHaveLength(1);

    drawTriangleAndFinish(20);

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes).toHaveLength(1); // no second node created
    const node = nodes[0];
    expect(node.id).toBe(nodeId);
    expect(isVectorNode(node) && node.paths).toHaveLength(2);

    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId });
    expect(usePathEditStateStore.getState().activeAnchor).toEqual({
      pathIndex: 1,
      anchorIndex: 0,
    });
  });

  it('with a locked vector node selected: creates a new node instead of appending', () => {
    drawTriangleAndFinish();
    const lockedId = useSceneStore.getState().scene.nodes[0].id;
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === lockedId ? { ...n, state: 'locked' } : n)),
      },
    }));
    useSelectionStore.getState().selectNode(lockedId);

    drawTriangleAndFinish(20);

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes).toHaveLength(2);
    const lockedNode = nodes.find((n) => n.id === lockedId);
    expect(lockedNode && isVectorNode(lockedNode) && lockedNode.paths).toHaveLength(1); // untouched
    const newNode = nodes.find((n) => n.id !== lockedId);
    expect(useSelectionStore.getState().selection).toEqual({
      kind: 'node',
      nodeId: newNode?.id,
    });
  });

  it('with a pixel node selected: creates a new vector node instead of appending', () => {
    const pixelId = useSceneStore
      .getState()
      .addPixelNode({ sourcePath: '/tmp/a.png', sourceSize: [10, 10] });
    useSelectionStore.getState().selectNode(pixelId);

    drawTriangleAndFinish();

    const nodes = useSceneStore.getState().scene.nodes;
    expect(nodes).toHaveLength(2);
    const vectorNode = nodes.find((n) => n.id !== pixelId);
    expect(vectorNode && isVectorNode(vectorNode)).toBe(true);
    expect(useSelectionStore.getState().selection).toEqual({
      kind: 'node',
      nodeId: vectorNode?.id,
    });
  });

  it('with nothing selected: creates a new vector node instead of appending', () => {
    drawTriangleAndFinish();
    useSelectionStore.getState().clear();

    drawTriangleAndFinish(20);

    expect(useSceneStore.getState().scene.nodes).toHaveLength(2);
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

describe('pen state store — appending to a node-pinned mask shape (mask-follows-node.md)', () => {
  it("maps anchors back through the inverse editing delta so the new path shows under the pointer, stored in the shape's own space", () => {
    drawTriangleAndFinish();
    const shapeId = useSceneStore.getState().scene.nodes[0].id;
    const attach = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: [
          ...s.scene.nodes,
          {
            id: 'consumer',
            label: 'Photo',
            type: 'pixel',
            state: 'active',
            output: 'image',
            cameraId: null,
            modifiers: [{ id: 'm1', type: 'invert', enabled: true, params: {} }],
            visible: true,
            blendMode: 'normal',
            opacity: 1,
            dirty: { draft: false, working: false },
            sourcePath: '/x.png',
            sourceSize: [100, 100],
          },
        ],
      },
    }));
    useSceneStore.getState().setModifierVectorMask('consumer', 'm1', shapeId, {
      featherPx: 0,
      expand: 0,
      invert: false,
      space: 'node',
      attachTransform: attach,
    });
    // The consumer moves 100 px right AFTER attach: the mask now reads 100 px right of its stored paths.
    useSceneStore
      .getState()
      .setNodeTransform('consumer', { x: 100, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
    useSelectionStore.getState().selectNode(shapeId);

    drawTriangleAndFinish(150); // pointer positions: x = 150, 160, 155 (where the mask is DISPLAYED)

    const node = useSceneStore.getState().scene.nodes.find((n) => n.id === shapeId);
    if (!node || !isVectorNode(node)) throw new Error('expected the shape');
    const xs = node.paths[1].anchors.map((a) => a.point.x);
    expect(xs.map((x) => Math.round(x))).toEqual([50, 60, 55]); // stored = pointer - 100
  });
});
