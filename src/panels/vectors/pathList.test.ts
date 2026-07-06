import { describe, expect, it } from 'vitest';
import type { VectorPath } from '@/scene/types';
import { deletePath, reorderPath } from './pathList';

function path(id: number, anchorCount = 3): VectorPath {
  return {
    closed: true,
    anchors: Array.from({ length: anchorCount }, (_, i) => ({ point: { x: id * 10 + i, y: 0 } })),
  };
}

describe('deletePath', () => {
  it('removes the path at the given index', () => {
    const paths = [path(0), path(1), path(2)];
    const result = deletePath(paths, 1);
    expect(result).toHaveLength(2);
    expect(result?.[0]).toBe(paths[0]);
    expect(result?.[1]).toBe(paths[2]);
  });

  it('returns null when deleting the last remaining path', () => {
    const paths = [path(0)];
    expect(deletePath(paths, 0)).toBeNull();
  });
});

describe('reorderPath', () => {
  it('moves a path from one index to another', () => {
    const paths = [path(0), path(1), path(2)];
    const result = reorderPath(paths, 0, 2);
    expect(result.map((p) => p.anchors[0].point.x)).toEqual([10, 20, 0]);
  });

  it('round-trips: reorder then reorder back restores original order', () => {
    const paths = [path(0), path(1), path(2)];
    const reordered = reorderPath(paths, 0, 2);
    const restored = reorderPath(reordered, 2, 0);
    expect(restored).toEqual(paths);
  });
});
