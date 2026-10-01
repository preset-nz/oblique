import { create } from 'zustand';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { defaultFontRef } from '@/fonts/resolveFont';
import type { FontRef } from '@/fonts/types';
import { deleteNode } from '@/scene/deleteNode';
import { beginTransaction, endTransaction } from '@/scene/history';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { isTextNode, type Point2D } from '@/scene/types';
import { useToolStateStore } from '../toolState';

/**
 * The open text edit (text-tool-and-inspector.md). UI-only and never persisted,
 * the same separation as `vector/penState.ts`: the scene only ever sees the
 * node and its `setTextProps` writes.
 *
 * One edit session = one history transaction. `beginNewTextAt`/`beginReEdit`
 * open it; `commitActiveTextEdit` closes it. Everything that can end an edit
 * (Escape, Cmd+Enter, a pointerdown elsewhere, a tool change, the selection
 * moving away, the menu's Undo/Redo) funnels through that one function so the
 * rule lives in one place and is idempotent.
 */

export interface TextEditing {
  nodeId: string;
  /** True when this session created the node (a blank one is discarded on commit). */
  isNew: boolean;
}

interface TextEditStore {
  editing: TextEditing | null;
  /** Per session, never persisted: what the next placed text starts with. */
  lastUsedFont: FontRef | null;
  lastUsedSize: number | null;
  begin: (nodeId: string, isNew: boolean) => void;
  end: () => void;
  setLastUsed: (patch: { font?: FontRef; fontSize?: number }) => void;
}

export const useTextEditStore = create<TextEditStore>((set) => ({
  editing: null,
  lastUsedFont: null,
  lastUsedSize: null,
  begin: (nodeId, isNew) => set({ editing: { nodeId, isNew } }),
  end: () => set({ editing: null }),
  setLastUsed: (patch) =>
    set((s) => ({
      lastUsedFont: patch.font ?? s.lastUsedFont,
      lastUsedSize: patch.fontSize ?? s.lastUsedSize,
    })),
}));

const DEFAULT_FONT_SIZE = 72;

/**
 * Commit rule. No-op when nothing is being edited; safe to call from several
 * triggers at once (the store is cleared first, so a re-entrant trigger — the
 * selection watcher reacting to `clearSelection()` below — finds nothing open).
 *
 * A new node whose content is blank is removed *before* the transaction ends:
 * the transaction then sees no net change, so no undo step is recorded.
 */
export function commitActiveTextEdit(): void {
  const { editing, end } = useTextEditStore.getState();
  if (!editing) return;
  end();

  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === editing.nodeId);
  if (editing.isNew && node && isTextNode(node) && node.content.trim() === '') {
    // removeNode + cache eviction (a cook may already have run on the blank node).
    deleteNode(editing.nodeId);
    const selection = useSelectionStore.getState().selection;
    if (selection.kind === 'node' && selection.nodeId === editing.nodeId) {
      useSelectionStore.getState().clear();
    }
  }
  endTransaction();
}

/** Text tool on empty canvas: a new blank node at `position`, selected, with its edit open. */
export function beginNewTextAt(position: Point2D): string {
  commitActiveTextEdit();
  const { lastUsedFont, lastUsedSize, begin } = useTextEditStore.getState();
  const font = lastUsedFont ?? defaultFontRef(useFontCatalogueStore.getState().faces);
  beginTransaction();
  const id = useSceneStore.getState().addTextNode({
    content: '',
    font,
    position,
    fontSize: lastUsedSize ?? DEFAULT_FONT_SIZE,
  });
  useSelectionStore.getState().selectNode(id);
  begin(id, true);
  return id;
}

/** Re-edit an existing text node. Returns false (and does nothing) for a missing, non-text or locked node. */
export function beginReEdit(nodeId: string): boolean {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (!node || !isTextNode(node) || node.state === 'locked') return false;
  commitActiveTextEdit();
  // Selecting before `begin` keeps the selection watcher below from reading
  // this as "selection moved away".
  useSelectionStore.getState().selectNode(nodeId);
  beginTransaction();
  useTextEditStore.getState().begin(nodeId, false);
  return true;
}

// Triggers that end an edit without going through the editor's own handlers.
useToolStateStore.subscribe((state, prev) => {
  if (state.tool !== prev.tool) commitActiveTextEdit();
});

useSelectionStore.subscribe((state) => {
  const editing = useTextEditStore.getState().editing;
  if (!editing) return;
  const { selection } = state;
  if (selection.kind !== 'node' || selection.nodeId !== editing.nodeId) commitActiveTextEdit();
});

// The node vanished under the edit (project load/new, delete from the layer list).
useSceneStore.subscribe((state) => {
  const editing = useTextEditStore.getState().editing;
  if (!editing) return;
  if (!state.scene.nodes.some((n) => n.id === editing.nodeId)) commitActiveTextEdit();
});
