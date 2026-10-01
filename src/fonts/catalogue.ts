import { create } from 'zustand';
import { useSceneStore } from '@/scene/store';
import { isTextNode } from '@/scene/types';
import { listFonts } from './fontsIpc';
import type { FontFace } from './types';

export interface FontFamilyGroup {
  family: string;
  faces: FontFace[];
}

interface FontCatalogueState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  faces: FontFace[];
  byPostscript: Map<string, FontFace>;
  /** Grouped by family, order preserved from Rust. */
  families: FontFamilyGroup[];
  /**
   * What the family picker lists: families with at least one Latin face. `families`
   * stays complete, so the matcher and missing-font detection resolve a document's
   * non-Latin font exactly (font-picker-curation.md).
   */
  pickerFamilies: FontFamilyGroup[];
  /** Idempotent: a second call while loading/ready is a no-op. */
  load: () => Promise<void>;
}

/** Groups consecutive faces sharing a family (Rust sorts case-insensitively by family). */
export function groupFamilies(faces: FontFace[]): FontFamilyGroup[] {
  const groups: FontFamilyGroup[] = [];
  const byKey = new Map<string, FontFamilyGroup>();
  for (const face of faces) {
    const key = face.family.toLowerCase();
    let group = byKey.get(key);
    if (!group) {
      group = { family: face.family, faces: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.faces.push(face);
  }
  return groups;
}

/** Families that can set basic Latin text (at least one face covers A–Z a–z). */
export const pickerFamiliesOf = (families: FontFamilyGroup[]): FontFamilyGroup[] =>
  families.filter((g) => g.faces.some((f) => f.latin));

export const useFontCatalogueStore = create<FontCatalogueState>(() => ({
  status: 'idle',
  faces: [],
  byPostscript: new Map(),
  families: [],
  pickerFamilies: [],
  load() {
    inFlight ??= loadOnce();
    return inFlight;
  },
}));

/**
 * Production text cooks wait on this before shaping (cook.ts). Before the
 * catalogue settles, `effectiveFontFor` can't substitute, so a restored
 * document whose font is missing would ask Rust for an unknown face and toast
 * a cook failure on every relaunch. Resolves once the catalogue is ready OR
 * errored, and never rejects.
 */
export function fontCatalogueSettled(): Promise<void> {
  return useFontCatalogueStore.getState().load();
}

let inFlight: Promise<void> | null = null;

/** Test-only: forget the memoised load so a fresh store can load again. */
export function resetCatalogueLoadForTests(): void {
  inFlight = null;
}

async function loadOnce(): Promise<void> {
  const { setState: set } = useFontCatalogueStore;
  set({ status: 'loading' });
  try {
    const faces = await listFonts();
    const families = groupFamilies(faces);
    set({
      status: 'ready',
      faces,
      byPostscript: new Map(faces.map((f) => [f.postscriptName, f])),
      families,
      pickerFamilies: pickerFamiliesOf(families),
    });
    // Text geometry may now resolve to a different face (missing-fonts.md).
    // The geometry cache keys on the spec's effective PostScript name, so
    // dirtying is enough: no flush. Draft-dirty also dirties working, and
    // dirty-only scene changes never reach history.
    const { scene, markDirty } = useSceneStore.getState();
    for (const node of scene.nodes) {
      if (isTextNode(node)) markDirty(node.id, 'draft');
    }
  } catch (err) {
    // No toast: text still renders by PostScript name; only the pickers and the
    // missing-font detection degrade.
    console.warn('Font catalogue unavailable:', err);
    set({
      status: 'error',
      faces: [],
      byPostscript: new Map(),
      families: [],
      pickerFamilies: [],
    });
  }
}
