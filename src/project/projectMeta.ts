import { create } from 'zustand';

/**
 * The current project file. Transient app state, never persisted. It lives in its own module
 * (re-exported from `io.ts`) so `scene/` — which `io.ts` imports — can read the current project
 * path for relative source resolution without an import cycle (image-source.md).
 *
 * It follows the status rhizome's document host reports (`bindProjectMeta`), and it has to be
 * here and synchronous: a replaced document's relative sources are resolved against this path
 * while the store is restored, which is before app-kit's own document event could arrive. The
 * name, the unsaved mark and the window title are app-kit's (`useDocument`), not kept here.
 */
interface ProjectMetaState {
  path: string | null;
}

export const useProjectMetaStore = create<ProjectMetaState>(() => ({
  path: null,
}));

/** The part of POM's status the meta store follows. */
export interface MetaStatus {
  path: string | null;
}

/** The part of the document host this needs, so that nothing here imports `rhizome/`. */
export interface StatusSource {
  status(): MetaStatus | null;
  onStatus(f: (s: MetaStatus) => void): () => void;
}

export function applyStatus(s: MetaStatus): void {
  if (useProjectMetaStore.getState().path === s.path) return;
  useProjectMetaStore.setState({ path: s.path });
}

/** Makes the meta store follow `source`'s status, from now on and from what it last said. */
export function bindProjectMeta(source: StatusSource): () => void {
  const first = source.status();
  if (first) applyStatus(first);
  return source.onStatus(applyStatus);
}
