import { create } from 'zustand';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { defaultFontRef } from '@/fonts/resolveFont';
import type { FontRef } from '@/fonts/types';
import { deleteNode } from '@/scene/deleteNode';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import {
  beginTransaction,
  cancelTransaction,
  endTransaction,
  hasTransactionBackend,
} from '@/scene/transaction';
import { isTextNode, type Point2D } from '@/scene/types';

/**
 * The open text edit (text-tool-and-inspector.md, revised by
 * dogfood-revisions.md). UI-only and never persisted, the same separation as
 * `pathEditState.ts`: the scene only ever sees the node and its
 * `setTextProps` writes.
 *
 * Lives in `scene/` so both the canvas (T tool, double-click, Enter) and the
 * inspector's Text field (focus/blur) can import it without importing each
 * other (depcruise: panels/ and canvas/ meet via stores).
 *
 * **The edit transaction is the Text field's focus.** The field calls
 * `beginTextEdit` on focus and `commitActiveTextEdit` on blur. One session =
 * one transaction (`transaction.ts`). The canvas never types: it only *asks* the field
 * to take focus (`focusRequest`), via `beginNewTextAt` / `beginReEdit`.
 * Everything else that can end an edit (a tool change, the selection moving
 * away, the node vanishing, the field's blur) funnels through
 * `commitActiveTextEdit`, so the rule lives in one place and is idempotent.
 *
 * **Undo while the field has focus is the field's own typing undo** (app-kit's text routing,
 * Epic 22 slice b): Edit > Undo then sends `text-undo` to the webview, which runs
 * `execCommand('undo')` on the field, and the document history is not touched. The commit
 * rule runs when the field blurs, and app-kit's webview `undo()` blurs it first. Undo from the
 * menu while an edit is open but the field is not focused (the instant after a T click) finds a
 * gesture open, so rhizome refuses it and Undo is greyed.
 */

export interface TextEditing {
  nodeId: string;
  /** True when this session created the node (a blank one is discarded on commit). */
  isNew: boolean;
}

/** A pending "focus the Text field" ask. The field consumes it on mount or when `focusRequest` bumps. */
export interface TextFocusTarget {
  nodeId: string;
  /**
   * True when a pointerdown caused the ask. That pointer's own default action
   * can still pull focus away a moment later, so the field defends the focus
   * until the pointer is released.
   */
  viaPointer: boolean;
}

interface TextEditStore {
  editing: TextEditing | null;
  /** Bumped on every ask for the field to take focus. */
  focusRequest: number;
  focusTarget: TextFocusTarget | null;
  /** Per session, never persisted: what the next placed text starts with. */
  lastUsedFont: FontRef | null;
  lastUsedSize: number | null;
  begin: (nodeId: string, isNew: boolean) => void;
  end: () => void;
  requestFocus: (nodeId: string, viaPointer: boolean) => void;
  consumeFocusRequest: () => void;
  setLastUsed: (patch: { font?: FontRef; fontSize?: number }) => void;
}

export const useTextEditStore = create<TextEditStore>((set) => ({
  editing: null,
  focusRequest: 0,
  focusTarget: null,
  lastUsedFont: null,
  lastUsedSize: null,
  begin: (nodeId, isNew) => set({ editing: { nodeId, isNew } }),
  end: () => set({ editing: null }),
  requestFocus: (nodeId, viaPointer) =>
    set((s) => ({ focusRequest: s.focusRequest + 1, focusTarget: { nodeId, viaPointer } })),
  consumeFocusRequest: () => set({ focusTarget: null }),
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
    const rhizomeHoldsIt = hasTransactionBackend();
    // Rhizome holds the document: take the whole gesture (the layer's creation) back below,
    // so the blank layer goes without a removeNode and leaves no undo step.
    // Otherwise removeNode + cache eviction (a cook may already have run on the blank node).
    if (!rhizomeHoldsIt) deleteNode(editing.nodeId);
    const selection = useSelectionStore.getState().selection;
    if (selection.kind === 'node' && selection.nodeId === editing.nodeId) {
      useSelectionStore.getState().clear();
    }
    if (rhizomeHoldsIt) {
      cancelTransaction();
      return;
    }
  }
  endTransaction();
}

/**
 * The Text field took focus. Opens the edit transaction unless this node's edit
 * is already open (`beginNewTextAt` opens it at creation, so the layer and its
 * words are one undo step). Does nothing for a missing, non-text or locked node.
 */
export function beginTextEdit(nodeId: string, isNew: boolean): void {
  if (useTextEditStore.getState().editing?.nodeId === nodeId) return;
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (!node || !isTextNode(node) || node.state === 'locked') return;
  commitActiveTextEdit();
  beginTransaction();
  useTextEditStore.getState().begin(nodeId, isNew);
}

/** Text tool on empty canvas: a new blank node at `position`, selected, with its edit open and the field asked to focus. */
export function beginNewTextAt(position: Point2D): string {
  commitActiveTextEdit();
  const { lastUsedFont, lastUsedSize, begin, requestFocus } = useTextEditStore.getState();
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
  requestFocus(id, true);
  return id;
}

/**
 * Re-edit an existing text node: select it and ask the field to take focus
 * (its focus opens the transaction, `beginTextEdit`). Returns false (and does
 * nothing) for a missing, non-text or locked node.
 */
export function beginReEdit(nodeId: string, opts: { viaPointer?: boolean } = {}): boolean {
  const node = useSceneStore.getState().scene.nodes.find((n) => n.id === nodeId);
  if (!node || !isTextNode(node) || node.state === 'locked') return false;
  commitActiveTextEdit();
  useSelectionStore.getState().selectNode(nodeId);
  useTextEditStore.getState().requestFocus(nodeId, opts.viaPointer ?? false);
  return true;
}

// Triggers that end an edit without going through the field's own handlers.
// (The tool-change trigger lives in canvas/text/textEditTriggers.ts: scene/
// can't import canvas/.)
useSelectionStore.subscribe((state) => {
  const { editing, focusTarget, consumeFocusRequest } = useTextEditStore.getState();
  const { selection } = state;
  // A pending ask for a node that is no longer selected is stale: drop it so the
  // field can't grab focus later, when that node is selected for another reason.
  if (focusTarget && (selection.kind !== 'node' || selection.nodeId !== focusTarget.nodeId)) {
    consumeFocusRequest();
  }
  if (!editing) return;
  if (selection.kind !== 'node' || selection.nodeId !== editing.nodeId) commitActiveTextEdit();
});

// The node vanished under the edit (project load/new, delete from the layer list).
useSceneStore.subscribe((state) => {
  const editing = useTextEditStore.getState().editing;
  if (!editing) return;
  if (!state.scene.nodes.some((n) => n.id === editing.nodeId)) commitActiveTextEdit();
});
