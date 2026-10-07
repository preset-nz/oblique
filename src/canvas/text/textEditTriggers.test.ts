import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { beginNewTextAt, useTextEditStore } from '@/scene/textEditState';
import { useToolStateStore } from '../toolState';
import './textEditTriggers';

beforeEach(() => {
  useSceneStore.setState({
    scene: {
      id: 's',
      nodes: [],
      cameras: [],
      defaultCameraId: null,
      resolution: 'working',
      documentSize: [800, 400],
    },
  });
  useSelectionStore.setState({ selection: { kind: 'none' } });
  useToolStateStore.setState({ tool: 'text' });
  useTextEditStore.setState({ editing: null, focusRequest: 0, focusTarget: null });
});

describe('textEditTriggers', () => {
  it('a tool change commits the open edit (a blank new node vanishes)', () => {
    beginNewTextAt({ x: 0, y: 0 });
    useToolStateStore.getState().setTool('move');
    expect(useTextEditStore.getState().editing).toBeNull();
    expect(useSceneStore.getState().scene.nodes).toHaveLength(0);
  });
});
