import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSceneStore } from '@/scene/store';

/**
 * Label a rename commit should write, or `null` when the commit is a no-op
 * (rename-nodes.md). Empty/whitespace-only is a cancel, not a nameless layer;
 * an unchanged name skips the store write entirely so a stray double-click
 * leaves nothing on the undo stack. Pure — no DOM, no store.
 */
export function commitLabel(draft: string, current: string): string | null {
  const trimmed = draft.trim();
  if (trimmed === '' || trimmed === current) return null;
  return trimmed;
}

/**
 * Inline rename for a node's label (rename-nodes.md), shared by the layer list and the
 * Selections tab (selections-panel.md). Double-click or F2 starts it (`start`), Enter and blur
 * commit, Escape cancels; `input` is the field to render while `editing`.
 *
 * The in-progress string is transient — local state, never scene state — so one `setNodeProp`
 * call on commit is one undo step per rename, not one per keystroke.
 */
export function useNodeRename(
  node: { id: string; label: string },
  ariaLabel = 'Layer name',
): { editing: boolean; start: () => void; input: ReactNode } {
  const setNodeProp = useSceneStore((s) => s.setNodeProp);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Both exits (Enter and Escape) unmount the input, and some browsers fire
  // blur on removal — this flag makes the resulting stray commit a no-op.
  // A duplicate identical write would be filtered by sceneDiff before it
  // reached history anyway; the flag keeps the one-undo-step-per-rename
  // guarantee from depending on that.
  const settledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select(); // typing replaces the old name
  }, [editing]);

  function start() {
    settledRef.current = false;
    setDraft(node.label);
    setEditing(true);
  }

  function commit() {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = commitLabel(draft, node.label);
    if (next !== null) setNodeProp(node.id, { label: next });
    setEditing(false);
  }

  function cancel() {
    settledRef.current = true;
    setEditing(false);
  }

  const input = (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Escape/Enter belong to the input while it's open — the canvas
        // Escape handler must not also clear the node selection.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      aria-label={ariaLabel}
      className="min-w-0 flex-1 rounded bg-neutral-900 px-1 text-xs outline-none ring-1 ring-neutral-600"
    />
  );

  return { editing, start, input };
}
