import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { Scene, VectorPath } from '@/scene/types';
import { isVectorNode } from '@/scene/types';
import { deletePath, reorderPath } from './vectors/pathList';

/**
 * Store-level coverage for the Vectors tab's acceptance criteria
 * (vectors-tab.md) that don't need a mounted component: path delete
 * dirties + recooks the node (dirty rule 1), and reorder round-trips
 * through save/load (JSON — the persistence format, `store.test.ts`'s own
 * "JSON round-trip" convention). Row-click-focuses-in-overlay isn't
 * headlessly testable (it's a `pathEditState.ts` store write asserted by
 * `PathEditor.tsx`'s render, no store-level behaviour to check beyond "it
 * called `setActiveAnchor`" — trivial and not worth a component-mount test
 * per this repo's "don't write UI snapshot tests" rule).
 */

function makePath(x0: number): VectorPath {
  return {
    closed: true,
    anchors: [
      { point: { x: x0, y: 0 } },
      { point: { x: x0 + 10, y: 0 } },
      { point: { x: x0 + 5, y: 10 } },
    ],
  };
}

beforeEach(() => {
  useSceneStore.setState({
    scene: {
      id: 'scene-1',
      nodes: [],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [100, 100],
    },
  });
});

describe('Vectors tab: path delete', () => {
  it('deleting one of several paths dirties the node (draft + working) for recook', () => {
    const paths = [makePath(0), makePath(100)];
    const id = useSceneStore.getState().addVectorNode({ paths, fillRule: 'nonzero' });
    useSceneStore.getState().clearDirty(id, 'draft');
    useSceneStore.getState().clearDirty(id, 'working');

    const result = deletePath(paths, 0);
    expect(result).not.toBeNull();
    useSceneStore.getState().setVectorPaths(id, result as VectorPath[]);

    const node = useSceneStore.getState().scene.nodes[0];
    expect(node).toMatchObject({ paths: [paths[1]] });
    expect(node.dirty).toEqual({ draft: true, working: true });
  });

  it('deleting the last remaining path removes the whole node', () => {
    const paths = [makePath(0)];
    const id = useSceneStore.getState().addVectorNode({ paths, fillRule: 'nonzero' });

    expect(deletePath(paths, 0)).toBeNull();
    useSceneStore.getState().removeNode(id);

    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });
});

describe('Vectors tab: path reorder round-trips through save/load', () => {
  it('reordered path order survives a setVectorPaths -> JSON -> loadScene round trip', () => {
    const paths = [makePath(0), makePath(100), makePath(200)];
    const id = useSceneStore.getState().addVectorNode({ paths, fillRule: 'nonzero' });

    const reordered = reorderPath(paths, 0, 2); // [100, 200, 0]
    useSceneStore.getState().setVectorPaths(id, reordered);

    const beforeSave = useSceneStore.getState().scene;
    const persisted: Scene = JSON.parse(JSON.stringify(beforeSave));
    useSceneStore.getState().loadScene(persisted);

    const node = useSceneStore.getState().scene.nodes[0];
    expect(node).toMatchObject({ paths: reordered });
    if (!isVectorNode(node)) throw new Error('expected a vector node');
    expect(node.paths.map((p) => p.anchors[0].point.x)).toEqual([100, 200, 0]);
  });
});
