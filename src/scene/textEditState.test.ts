import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import type { FontRef } from '@/fonts/types';
import { useSelectionStore } from './selection';
import { useSceneStore } from './store';
import {
  beginNewTextAt,
  beginReEdit,
  beginTextEdit,
  commitActiveTextEdit,
  useTextEditStore,
} from './textEditState';
import { setTransactionBackend } from './transaction';
import type { Scene, TextNode } from './types';

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

/** An existing text node that predates the edit . */
function existingText(content = 'HELLO'): string {
  return useSceneStore.getState().addTextNode({ content, font, position: { x: 10, y: 60 } });
}

beforeEach(() => {
  useSceneStore.setState({ scene: emptyScene() });
  useSelectionStore.setState({ selection: { kind: 'none' } });
  useTextEditStore.setState({
    editing: null,
    focusRequest: 0,
    focusTarget: null,
    lastUsedFont: null,
    lastUsedSize: null,
  });
  useFontCatalogueStore.setState({ status: 'idle', faces: [] });
});

afterEach(() => setTransactionBackend(null));

/**
 * Stands in for rhizome: what the edit asks of it, in order. Undo is app-kit's and rhizome's now
 * (rhizome.test.ts holds the end-to-end steps); what this file owns is where a session's one
 * transaction begins and ends.
 */
function spyOnTransactions(): string[] {
  const calls: string[] = [];
  setTransactionBackend({
    begin: () => void calls.push('begin'),
    end: () => void calls.push('end'),
    cancel: () => void calls.push('cancel'),
  });
  return calls;
}

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
  });

  it('new + blank: removes the node and clears the selection', () => {
    const id = beginNewTextAt({ x: 5, y: 6 });
    expect(edit().editing).toEqual({ nodeId: id, isNew: true });
    expect(textAt(id)).toMatchObject({ content: '', position: { x: 5, y: 6 } });
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: id });

    commitActiveTextEdit();

    expect(scene().nodes).toHaveLength(0);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'none' });
    expect(edit().editing).toBeNull();
  });

  it('new + typed: one transaction for the whole session, from the click to the commit', () => {
    const calls = spyOnTransactions();
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, 'T');
    type(id, 'THE DEAD MARCH');
    expect(calls).toEqual(['begin']);
    commitActiveTextEdit();
    expect(textAt(id).content).toBe('THE DEAD MARCH');
    expect(calls).toEqual(['begin', 'end']);
  });

  it('new + blank with rhizome behind it: the gesture is cancelled, not ended', () => {
    const calls = spyOnTransactions();
    const id = beginNewTextAt({ x: 0, y: 0 });
    expect(id).toBeDefined();
    commitActiveTextEdit();
    expect(calls).toEqual(['begin', 'cancel']);
    expect(edit().editing).toBeNull();
  });

  it('re-edit: the ask opens nothing, the field focus opens one transaction, the blur ends it', () => {
    const calls = spyOnTransactions();
    const id = existingText('HELLO');
    expect(beginReEdit(id)).toBe(true);
    // The ask alone opens nothing: the field's focus does.
    expect(edit().editing).toBeNull();
    expect(calls).toEqual([]);
    beginTextEdit(id, false); // field focus
    expect(edit().editing).toEqual({ nodeId: id, isNew: false });
    type(id, 'HELLO W');
    type(id, 'HELLO WORLD');
    commitActiveTextEdit();
    expect(textAt(id).content).toBe('HELLO WORLD');
    expect(calls).toEqual(['begin', 'end']);
  });

  it('re-edit that blanks the content keeps the node (only new blank nodes are discarded)', () => {
    const calls = spyOnTransactions();
    const id = existingText('HELLO');
    beginReEdit(id);
    beginTextEdit(id, false);
    type(id, '');
    commitActiveTextEdit();
    expect(textAt(id).content).toBe('');
    expect(calls).toEqual(['begin', 'end']);
  });

  it('is idempotent: a second commit does nothing', () => {
    const calls = spyOnTransactions();
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, 'A');
    commitActiveTextEdit();
    commitActiveTextEdit();
    expect(calls).toEqual(['begin', 'end']);
    expect(scene().nodes).toHaveLength(1);
  });

  it('new + whitespace-only is still blank', () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, '  \n ');
    commitActiveTextEdit();
    expect(scene().nodes).toHaveLength(0);
  });

  it('re-edit that changes nothing records no step', () => {
    const id = existingText();
    beginReEdit(id);
    beginTextEdit(id, false);
    commitActiveTextEdit(); // field blur
  });
});

describe('the edit transaction is the field focus (dogfood-revisions.md)', () => {
  it('a new node: the field focusing after the T click opens no second transaction', () => {
    const calls = spyOnTransactions();
    const id = beginNewTextAt({ x: 0, y: 0 });
    beginTextEdit(id, false); // the field's onFocus
    expect(edit().editing).toEqual({ nodeId: id, isNew: true });
    type(id, 'ABC');
    commitActiveTextEdit(); // blur
    expect(calls).toEqual(['begin', 'end']);
  });

  it('typing on after a commit while the caret stays in the field opens a fresh transaction', () => {
    const calls = spyOnTransactions();
    const id = existingText('HELLO');
    beginTextEdit(id, false);
    type(id, 'HELLO WORLD');
    commitActiveTextEdit();
    // the caret is still in the field: the next keystroke re-opens an edit (the field's onChange)
    beginTextEdit(id, false);
    type(id, 'HELLO!');
    commitActiveTextEdit();
    expect(calls).toEqual(['begin', 'end', 'begin', 'end']);
  });

  it('new + blank: focus then blur leaves no node', () => {
    const id = beginNewTextAt({ x: 0, y: 0 });
    beginTextEdit(id, false);
    commitActiveTextEdit();
    expect(scene().nodes).toHaveLength(0);
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'none' });
  });

  it('beginTextEdit ignores a locked or missing node', () => {
    const id = existingText();
    useSceneStore.setState({
      scene: {
        ...scene(),
        nodes: scene().nodes.map((n) => (n.id === id ? { ...n, state: 'locked' as const } : n)),
      },
    });
    beginTextEdit(id, false);
    beginTextEdit('nope', false);
    expect(edit().editing).toBeNull();
  });
});

describe('focus requests', () => {
  it('a T click creates the node, selects it and bumps the focus request', () => {
    const before = edit().focusRequest;
    const id = beginNewTextAt({ x: 5, y: 6 });
    expect(edit().focusRequest).toBe(before + 1);
    expect(edit().focusTarget).toEqual({ nodeId: id, viaPointer: true });
    expect(useSelectionStore.getState().selection).toEqual({ kind: 'node', nodeId: id });
  });

  it('re-editing bumps the request (viaPointer only when asked)', () => {
    const id = existingText();
    beginReEdit(id);
    expect(edit().focusRequest).toBe(1);
    expect(edit().focusTarget).toEqual({ nodeId: id, viaPointer: false });
    beginReEdit(id, { viaPointer: true });
    expect(edit().focusRequest).toBe(2);
    expect(edit().focusTarget).toEqual({ nodeId: id, viaPointer: true });
  });

  it('a locked node honours no focus request', () => {
    const id = existingText();
    useSceneStore.setState({
      scene: {
        ...scene(),
        nodes: scene().nodes.map((n) => (n.id === id ? { ...n, state: 'locked' as const } : n)),
      },
    });
    beginReEdit(id);
    expect(edit().focusRequest).toBe(0);
    expect(edit().focusTarget).toBeNull();
  });

  it('consuming clears the target; a stale target is dropped when the selection moves on', () => {
    const id = existingText();
    beginReEdit(id);
    edit().consumeFocusRequest();
    expect(edit().focusTarget).toBeNull();

    beginReEdit(id);
    useSelectionStore.getState().clear();
    expect(edit().focusTarget).toBeNull();
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
  it('the selection moving away commits', () => {
    const calls = spyOnTransactions();
    const id = beginNewTextAt({ x: 0, y: 0 });
    type(id, 'KEEP');
    useSelectionStore.getState().clear();
    expect(edit().editing).toBeNull();
    expect(textAt(id).content).toBe('KEEP');
    expect(calls).toEqual(['begin', 'end']);
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
