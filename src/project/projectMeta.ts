import { create } from 'zustand';

/**
 * Current project file + unsaved-changes flag. Transient app state, never
 * persisted; the window title and status bar mirror it. Lives in its own
 * module (re-exported from `io.ts`) so `scene/` — which `io.ts` imports — can
 * read the current project path for relative source resolution without an
 * import cycle (image-source.md).
 */
interface ProjectMetaState {
  path: string | null;
  dirtySinceSave: boolean;
  setPath: (path: string | null) => void;
  markSaved: () => void;
  markMutated: () => void;
}

export const useProjectMetaStore = create<ProjectMetaState>((set) => ({
  path: null,
  dirtySinceSave: false,
  setPath: (path) => set({ path }),
  markSaved: () => set({ dirtySinceSave: false }),
  markMutated: () => set({ dirtySinceSave: true }),
}));
