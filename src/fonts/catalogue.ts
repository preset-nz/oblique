import { create } from 'zustand';
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

export const useFontCatalogueStore = create<FontCatalogueState>((set, get) => ({
  status: 'idle',
  faces: [],
  byPostscript: new Map(),
  families: [],
  async load() {
    const { status } = get();
    if (status === 'loading' || status === 'ready') return;
    set({ status: 'loading' });
    try {
      const faces = await listFonts();
      set({
        status: 'ready',
        faces,
        byPostscript: new Map(faces.map((f) => [f.postscriptName, f])),
        families: groupFamilies(faces),
      });
    } catch (err) {
      // No toast: text still renders by PostScript name; only the pickers and the
      // missing-font detection degrade.
      console.warn('Font catalogue unavailable:', err);
      set({ status: 'error', faces: [], byPostscript: new Map(), families: [] });
    }
  },
}));
