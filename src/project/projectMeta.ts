import { create } from 'zustand';

/**
 * Current project file + unsaved-changes flag. Transient app state, never persisted; the
 * window title and status bar mirror it. Lives in its own module (re-exported from `io.ts`)
 * so `scene/` — which `io.ts` imports — can read the current project path for relative source
 * resolution without an import cycle (image-source.md).
 *
 * Epic 21 story 1: both fields come from the status rhizome's document host reports
 * (`bindProjectMeta`), not from watching the scene. A new document is not unsaved; an edit,
 * undo or redo makes it so; a save clears it.
 */
interface ProjectMetaState {
  path: string | null;
  dirtySinceSave: boolean;
}

export const useProjectMetaStore = create<ProjectMetaState>(() => ({
  path: null,
  dirtySinceSave: false,
}));

/** The part of POM's status the meta store follows. */
export interface MetaStatus {
  path: string | null;
  unsaved: boolean;
}

/** The part of the document host this needs, so that nothing here imports `rhizome/`. */
export interface StatusSource {
  status(): MetaStatus | null;
  onStatus(f: (s: MetaStatus) => void): () => void;
}

export function applyStatus(s: MetaStatus): void {
  const now = useProjectMetaStore.getState();
  if (now.path === s.path && now.dirtySinceSave === s.unsaved) return;
  useProjectMetaStore.setState({ path: s.path, dirtySinceSave: s.unsaved });
}

/** Makes the meta store follow `source`'s status, from now on and from what it last said. */
export function bindProjectMeta(source: StatusSource): () => void {
  const first = source.status();
  if (first) applyStatus(first);
  return source.onStatus(applyStatus);
}
