import { beforeEach, describe, expect, it } from 'vitest';
import * as history from '@/scene/history';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { beginNewTextAt, beginReEdit, useTextEditStore } from '@/scene/textEditState';
import { useTextSectionStore } from './textSectionCollapse';

const font = {
  family: 'Helvetica',
  style: 'Regular',
  postscriptName: 'Helvetica',
  weight: 400,
  italic: false,
  category: 'sans' as const,
};

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
  useTextEditStore.setState({ editing: null, focusRequest: 0, focusTarget: null });
  useTextSectionStore.setState({ collapsed: false });
  history.clear();
});

describe('Text section collapse', () => {
  it('toggles one global flag', () => {
    useTextSectionStore.getState().toggle();
    expect(useTextSectionStore.getState().collapsed).toBe(true);
    useTextSectionStore.getState().toggle();
    expect(useTextSectionStore.getState().collapsed).toBe(false);
  });

  it('a T click (new text) expands a collapsed section before the field can focus', () => {
    useTextSectionStore.setState({ collapsed: true });
    beginNewTextAt({ x: 0, y: 0 });
    expect(useTextSectionStore.getState().collapsed).toBe(false);
    // The ask is still pending: the field consumes it when it mounts.
    expect(useTextEditStore.getState().focusTarget).not.toBeNull();
  });

  it('a double-click / Enter re-edit expands a collapsed section', () => {
    const id = useSceneStore
      .getState()
      .addTextNode({ content: 'HI', font, position: { x: 0, y: 0 } });
    useTextSectionStore.setState({ collapsed: true });
    expect(beginReEdit(id)).toBe(true);
    expect(useTextSectionStore.getState().collapsed).toBe(false);
  });

  it('a refused request (locked node) leaves the section collapsed', () => {
    const id = useSceneStore
      .getState()
      .addTextNode({ content: 'HI', font, position: { x: 0, y: 0 } });
    useSceneStore.setState((s) => ({
      scene: {
        ...s.scene,
        nodes: s.scene.nodes.map((n) => (n.id === id ? { ...n, state: 'locked' as const } : n)),
      },
    }));
    useTextSectionStore.setState({ collapsed: true });
    expect(beginReEdit(id)).toBe(false);
    expect(useTextSectionStore.getState().collapsed).toBe(true);
  });
});
