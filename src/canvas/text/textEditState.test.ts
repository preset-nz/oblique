import { beforeEach, describe, expect, it } from 'vitest';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import type { FontRef } from '@/fonts/types';
import * as history from '@/scene/history';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import type { Scene, TextNode } from '@/scene/types';
import { useToolStateStore } from '../toolState';
import {
  beginNewTextAt,
  beginReEdit,
  commitActiveTextEdit,
  useTextEditStore,
} from './textEditState';

const font: FontRef = {
  family: 'Helvetica',
  style: 'Regular',
  postscriptName: 'Helvetica',
  weight: 400,
  italic: false,
  category: 'sans',
};

function emptyScene(): Scene {
  return {
    id: 's',
    nodes: [],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working',
    documentSize: [800, 400],
  };
}

const scene = () => useSceneStore.getState().scene;
const edit = () => useTextEditStore.getState();
const textAt = (id: string) => scene().nodes.find((n) => n.id === id) as TextNode;
const type = (id: string, content: string) =>
  useSceneStore.getState().setTextProps(id, { content });

/** An existing text node that predates the edit (its creation is not part of any later undo step). */
function existingText(content = 'HELLO'): string {
  const id = useSceneStore.getState().addTextNode({ content, font, position: { x: 10, y: 60 } });
  history.clear();
  return id;
}

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useSelectionStore.setState({ selection: { kind: 'none' } });
  useToolStateStore.setState({ tool: 'text' });
  useTextEditStore.setState({ editing: null, lastUsedFont: null, lastUsedSize: null });
  useFontCatalogueStore.setState({ status: 'idle', faces: [] });
  history.clear();
});

describe('textEditState store', () => {
  it('begin/end set and clear the open edit', () => {
    expect(edit().editing).toBeNull();
    edit().begin('n1', true);
    expect(edit().editing).toEqual({ nodeId: 'n1', isNew: true });
    edit().end();
    expect(edit().editing).toBeNull();
  });

  it('setLastUsed merges and keeps the other field', () => {
    edit().setLastUsed({ fontSize: 40 });
    edit().setLastUsed({ font });
    expect(edit().lastUsedFont).toEqual(font);
    expect(edit().lastUsedSize).toBe(40);
  });
});

describe('commitActiveTextEdit', () => {
  it('is a no-op when nothing is being edited', () => {
    const before = scene();
    commitActiveTextEdit();
    expect(scene()).toBe(before);
    expect(history.canUndo()).toBe(false);
  });

  it('new + blank: removes the node, clears the selection, records no history', () => {
    const id = beginNewTextAt({ x: 5, y: 6 });
    expect(edit().editing).toEqual({ nodeId: id, isNew: true });
    expect(textAt(id)).toMatchObject({ content: '', position: { x: 5, y: 6 } });
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: id });

    commitActiveTextEdit();

    expect(scene().nodes).toHaveLength(0);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'none' });
    expect(edit().editing).toBeNull();
    expect(history.canUndo()).toBe(false);
  });

  it('new + whitespace-only is still blank', () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, '  \n ');
    commitActiveTextEdit();
    expect(scene().nodes).toHaveLength(0);
    expect(history.canUndo()).toBe(false);
  });

  it('new + typed: exactly one undo step for the whole session', async () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, 'T');
    type(id, 'TH');
    type(id, 'THE DEAD MARCH');
    commitActiveTextEdit();

    expect(textAt(id).content).toBe('THE DEAD MARCH');
    expect(history.canUndo()).toBe(true);

    await history.undo();
    expect(scene().nodes).toHaveLength(0);
    expect(history.canUndo()).toBe(false);

    await history.redo();
    expect(scene().nodes).toHaveLength(1);
    expect(scene().nodes[0].id).toBe(id);
  });

  it('Cmd+Z while editing (commit, then undo) leaves no node, and redo brings it back', async () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, 'HELLO');

    // What menu.ts does for menu://edit/undo.
    commitActiveTextEdit();
    await history.undo();

    expect(scene().nodes).toHaveLength(0);
    expect(edit().editing).toBeNull();
    expect(history.canUndo()).toBe(false);

    await history.redo();
    expect(textAt(id).content).toBe('HELLO');
  });

  it('re-edit: one undo step restores the original words', async () => {
    const id = existingText('HELLO');
    expect(beginReEdit(id)).toBe(true);
    expect(edit().editing).toEqual({ nodeId: id, isNew: false });
    type(id, 'HELLO W');
    type(id, 'HELLO WORLD');
    commitActiveTextEdit();

    expect(textAt(id).content).toBe('HELLO WORLD');
    await history.undo();
    expect(textAt(id).content).toBe('HELLO');
    expect(history.canUndo()).toBe(false);
  });

  it('re-edit that changes nothing records no step', () => {
    const id = existingText();
    beginReEdit(id);
    commitActiveTextEdit();
    expect(history.canUndo()).toBe(false);
  });

  it('re-edit that blanks the content keeps the node (only new blank nodes are discarded)', () => {
    const id = existingText('HELLO');
    beginReEdit(id);
    type(id, '');
    commitActiveTextEdit();
    expect(textAt(id).content).toBe('');
    expect(history.canUndo()).toBe(true);
  });

  it('is idempotent: a second commit does nothing', async () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, 'A');
    commitActiveTextEdit();
    commitActiveTextEdit();
    await history.undo();
    expect(history.canUndo()).toBe(false);
  });
});

describe('beginReEdit', () => {
  it('does nothing for a locked node', () => {
    const id = existingText();
    useSceneStore.setState({
      scene: {
        ...scene(),
        nodes: scene().nodes.map((n) => (n.id === id ? { ...n, state: 'locked' as const } : n)),
      },
    });
    expect(beginReEdit(id)).toBe(false);
    expect(edit().editing).toBeNull();
  });

  it('does nothing for a missing node or a non-text node', () => {
    expect(beginReEdit('nope')).toBe(false);
  });

  it('selects the node it edits', () => {
    const id = existingText();
    beginReEdit(id);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: id });
  });
});

describe('other ways an edit ends', () => {
  it('a tool change commits (a blank new node vanishes)', () => {
    beginNewTextAt({ x: 0, y: 0 });
    useToolStateStore.getState().setTool('move');
    expect(edit().editing).toBeNull();
    expect(scene().nodes).toHaveLength(0);
    expect(history.canUndo()).toBe(false);
  });

  it('the selection moving away commits', () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, 'KEEP');
    useSelectionStore.getState().clear();
    expect(edit().editing).toBeNull();
    expect(textAt(id).content).toBe('KEEP');
    expect(history.canUndo()).toBe(true);
  });

  it('the node vanishing under the edit (project load) closes it', () => {
    beginNewTextAt({ x: 0, y: 0 });
    useSceneStore.setState({ scene: emptyScene() });
    expect(edit().editing).toBeNull();
  });
});

describe('placing new text', () => {
  it('falls back to the catalogue default font and 72px', () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    expect(textAt(id).fontSize).toBe(72);
    expect(textAt(id).font.family).toBe('Helvetica Neue');
  });

  it('uses lastUsedFont / lastUsedSize once the inspector has set them', () => {
    const mono: FontRef = { ...font, family: 'Menlo', postscriptName: 'Menlo-Regular' };
    edit().setLastUsed({ font: mono, fontSize: 24 });
    const id = beginNewTextAt({ x: 0, y: 0 });
    expect(textAt(id).font).toEqual(mono);
    expect(textAt(id).fontSize).toBe(24);
  });
});
