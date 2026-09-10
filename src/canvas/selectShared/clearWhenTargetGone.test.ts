import { beforeEach, describe, expect, it } from 'vitest';
import { useColourSelectStore } from '@/canvas/colourSelect/state';
import { useSmartSelectStore } from '@/canvas/smartSelect/state';
import { useMarqueeStateStore } from '@/scene/marquee';
import { useSceneStore } from '@/scene/store';

function addPixelNode(): string {
  return useSceneStore.getState().addPixelNode({ sourcePath: '/img.png', sourceSize: [10, 10] });
}

describe('selection tool state survives only as long as its target node', () => {
  beforeEach(() => {
    useSceneStore.getState().resetScene();
    useColourSelectStore.getState().clear();
    useSmartSelectStore.getState().clear();
  });

  it('resetScene (New project) clears the marquee and both tool stores', () => {
    const id = addPixelNode();
    useColourSelectStore.getState().setTarget(id);
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);
    useSmartSelectStore.getState().setTarget(id);
    useMarqueeStateStore.getState().setMarquee({
      kind: 'polygons',
      polygons: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
      ],
    });

    useSceneStore.getState().resetScene();

    expect(useMarqueeStateStore.getState().marquee).toBeNull();
    expect(useColourSelectStore.getState().targetNodeId).toBeNull();
    expect(useColourSelectStore.getState().seeds).toEqual([]);
    expect(useSmartSelectStore.getState().targetNodeId).toBeNull();
  });

  it('loadScene (Open project) clears the marquee', () => {
    useMarqueeStateStore.getState().setMarquee({ kind: 'rect', rect: { x: 0, y: 0, w: 5, h: 5 } });
    useSceneStore.getState().loadScene(useSceneStore.getState().scene);
    expect(useMarqueeStateStore.getState().marquee).toBeNull();
  });

  it('deleting the target node clears the tool store; other node changes do not', () => {
    const id = addPixelNode();
    const other = addPixelNode();
    useColourSelectStore.getState().setTarget(id);
    useColourSelectStore.getState().setSeed({ x: 1, y: 1 }, 1);

    useSceneStore.getState().removeNode(other);
    expect(useColourSelectStore.getState().targetNodeId).toBe(id);

    useSceneStore.getState().removeNode(id);
    expect(useColourSelectStore.getState().targetNodeId).toBeNull();
    expect(useColourSelectStore.getState().seeds).toEqual([]);
  });
});
