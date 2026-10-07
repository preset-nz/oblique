import { useEffect, useRef } from 'react';
import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';

/**
 * Composition note (composition-note.md): one plain free-text note per
 * project. One undo step per editing session — the transaction opens on
 * focus and closes on blur, after 1 s of typing idle, and on unmount (the
 * same bounding as the background colour picker in `DocumentSetup.tsx`:
 * blur isn't guaranteed, and a transaction left open would swallow unrelated
 * later edits into this step).
 */
const IDLE_CLOSE_MS = 1000;

export function NotesPanel() {
  const note = useSceneStore((s) => s.scene.note ?? '');
  const setNote = useSceneStore((s) => s.setNote);

  const open = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const beginStep = () => {
    if (open.current) return;
    open.current = true;
    beginTransaction();
  };
  const endStep = () => {
    clearTimeout(idle.current);
    if (!open.current) return;
    open.current = false;
    endTransaction();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup; endStep reads refs
  useEffect(() => endStep, []);

  return (
    <textarea
      value={note}
      placeholder="Notes about this piece"
      aria-label="Composition note"
      spellCheck
      onFocus={beginStep}
      onChange={(e) => {
        beginStep();
        setNote(e.target.value);
        clearTimeout(idle.current);
        idle.current = setTimeout(endStep, IDLE_CLOSE_MS);
      }}
      onBlur={endStep}
      className="h-full w-full resize-none rounded border border-neutral-800 bg-neutral-900 p-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
    />
  );
}
