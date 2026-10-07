/**
 * Coalescing edits into one undo step (Epic 22, slice b; this is what is left of Epic 13's
 * snapshot history, which rhizome and app-kit replaced).
 *
 * Undo and redo are not here: they are app-kit's Edit menu items, which run the document host's
 * history in Rust and tell the webview with `history-stepped` (`rhizome/rhizome.ts` rebuilds the
 * store from it). What the webview still decides is where one step starts and ends: a scrub, a
 * drag or a text edit wraps its writes in `beginTransaction` / `endTransaction` so they land as
 * one undo step. Rhizome calls that a gesture, and `installRhizome` hands these three over to it.
 *
 * Without a backend (the web build, and the store's own tests) a transaction is nothing: the
 * calls are no-ops and `cancelTransaction` does nothing. The hooks are injected so `scene/`
 * doesn't import `rhizome/` (depcruise).
 */

/** What rhizome supplies: a gesture around the writes that follow. */
export interface TransactionBackend {
  begin: () => void;
  end: () => void;
  cancel: () => void;
}

let backend: TransactionBackend | null = null;

/** True while rhizome holds the document: a transaction can then be cancelled. */
export const hasTransactionBackend = (): boolean => backend !== null;

/** Hands transactions to rhizome (or takes them back with `null`). */
export function setTransactionBackend(next: TransactionBackend | null): void {
  backend = next;
}

/**
 * Marks the start of one coalesced undo step (a scrub-drag, a text edit). Every write until
 * `endTransaction` collapses into that one step. An unmatched earlier begin (a pointer-cancel
 * that never reached its end) is closed first by the backend, so a missed release can never
 * wedge history shut.
 */
export function beginTransaction(): void {
  backend?.begin();
}

/** Marks the end of a coalesced undo step. No-op if none is open. */
export function endTransaction(): void {
  backend?.end();
}

/** Takes back everything done since `beginTransaction`, leaving no undo step. */
export function cancelTransaction(): void {
  backend?.cancel();
}
