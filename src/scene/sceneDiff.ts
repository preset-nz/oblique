import type { Scene } from './types';

/**
 * True when two scene snapshots differ in anything BUT the per-node `dirty`
 * flags — i.e. a real edit, as opposed to cook churn (`clearDirty`/`markDirty`
 * swap the scene object while changing only dirty state). Two consumers with
 * the same need: history capture (a cook completing is not a user action —
 * Cmd+Z must never replay it) and the cook scheduler (cook churn must not
 * reset the draft/working idle timers, or completing cooks starve pending
 * ones).
 */
export function sceneChangedIgnoringDirty(a: Scene, b: Scene): boolean {
  if (a === b) return false;
  if (a.nodes.length !== b.nodes.length) return true;
  if (a.documentSize[0] !== b.documentSize[0] || a.documentSize[1] !== b.documentSize[1]) {
    return true;
  }
  if (a.resolution !== b.resolution) return true;
  if (a.defaultCameraId !== b.defaultCameraId) return true;
  // The document background (colour or image) is a real, undoable edit.
  if (
    a.background !== b.background &&
    JSON.stringify(a.background ?? null) !== JSON.stringify(b.background ?? null)
  ) {
    return true;
  }
  // The composition note is a real, undoable edit (composition-note.md);
  // absent and empty are the same thing.
  if ((a.note ?? '') !== (b.note ?? '')) return true;
  // Mask edits are real edits (selection-to-mask.md): same-id maskRefs
  // entries with different geometry/feather must register here or
  // history/scheduler treat them as cook churn.
  if (
    a.maskRefs !== b.maskRefs &&
    JSON.stringify(a.maskRefs ?? {}) !== JSON.stringify(b.maskRefs ?? {})
  ) {
    return true;
  }

  for (let i = 0; i < a.nodes.length; i++) {
    const na = a.nodes[i];
    const nb = b.nodes[i];
    if (na.id !== nb.id) return true; // reorder
    const { dirty: _a, ...restA } = na;
    const { dirty: _b, ...restB } = nb;
    if (JSON.stringify(restA) !== JSON.stringify(restB)) return true;
  }
  return false;
}

/**
 * True when some node's dirty flag went false -> true between two snapshots with
 * no other change needed. The cook scheduler treats this as a trigger even though
 * `sceneChangedIgnoringDirty` calls it churn: only `clearDirty` (true -> false)
 * is cook churn, while a rising flag means something outside the edit stream
 * (the font catalogue becoming ready, missing-fonts.md) wants a recook.
 */
export function dirtyRose(a: Scene, b: Scene): boolean {
  if (a === b) return false;
  const before = new Map(a.nodes.map((n) => [n.id, n.dirty]));
  for (const node of b.nodes) {
    const was = before.get(node.id);
    if (!was) continue; // a new node arrives through the real-edit path
    if ((node.dirty.draft && !was.draft) || (node.dirty.working && !was.working)) return true;
  }
  return false;
}

/**
 * The composition note (composition-note.md) never affects pixels; skip the
 * recomposite when it's the only top-level scene field that changed, so
 * typing in the Notes tab doesn't repaint the canvas on every keystroke.
 */
export function onlyNoteChanged(a: Scene, b: Scene): boolean {
  if (a.note === b.note) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'note') continue;
    if (a[key as keyof Scene] !== b[key as keyof Scene]) return false;
  }
  return true;
}
