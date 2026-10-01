import { useMemo } from 'react';
import { create } from 'zustand';
import { useSceneStore } from '@/scene/store';
import { isTextNode, type TextNode } from '@/scene/types';
import { useFontCatalogueStore } from './catalogue';
import { type CatalogueView, substituteFor } from './effectiveFont';
import { resolveFont } from './resolveFont';
import { type FontFace, type FontRef, fontRefOf } from './types';

/** One font a document asks for, with what stands in for it when it isn't installed. */
export interface UsedFont {
  wanted: FontRef;
  /** The installed stand-in; `null` when the font is installed, or nothing is installed at all. */
  substitute: FontRef | null;
  missing: boolean;
  nodeIds: string[];
}

export type MissingFont = UsedFont & { missing: true };

const byFamilyThenStyle = (a: UsedFont, b: UsedFont): number =>
  a.wanted.family.localeCompare(b.wanted.family) || a.wanted.style.localeCompare(b.wanted.style);

/**
 * Every font the text nodes use, grouped by wanted PostScript name and sorted by
 * family then style. Pure. `missing` is judged against `faces` alone, so the
 * caller decides whether the catalogue is ready.
 */
export function findUsedFonts(nodes: readonly TextNode[], faces: readonly FontFace[]): UsedFont[] {
  const installed = new Set(faces.map((f) => f.postscriptName));
  const groups = new Map<string, UsedFont>();
  for (const node of nodes) {
    const key = node.font.postscriptName;
    const existing = groups.get(key);
    if (existing) {
      existing.nodeIds.push(node.id);
      continue;
    }
    const missing = !installed.has(key);
    const hit = missing ? resolveFont(node.font, faces as FontFace[]) : null;
    groups.set(key, {
      wanted: node.font,
      substitute: hit ? fontRefOf(hit.face) : null,
      missing,
      nodeIds: [node.id],
    });
  }
  return [...groups.values()].sort(byFamilyThenStyle);
}

/** `findUsedFonts` narrowed to the fonts the catalogue lacks (missing-fonts.md). */
export function findMissingFonts(
  nodes: readonly TextNode[],
  faces: readonly FontFace[],
): MissingFont[] {
  return findUsedFonts(nodes, faces).filter((u): u is MissingFont => u.missing);
}

export const fontLabel = (f: FontRef): string => `${f.family} ${f.style}`;

/** The amber badge / inspector tooltip text. */
export function missingFontTooltip(wanted: FontRef, substitute: FontRef | null): string {
  return substitute
    ? `Font missing: ${fontLabel(wanted)} — showing ${fontLabel(substitute)}`
    : `Font missing: ${fontLabel(wanted)} — no installed font to show instead`;
}

/**
 * For one node's wanted font: the substitution when it is missing, else `null`.
 * Reactive, for the layer badge and the inspector marker.
 */
export function useMissingFont(wanted: FontRef): { substitute: FontRef | null } | null {
  const status = useFontCatalogueStore((s) => s.status);
  const faces = useFontCatalogueStore((s) => s.faces);
  const byPostscript = useFontCatalogueStore((s) => s.byPostscript);
  return useMemo(() => {
    const catalogue: CatalogueView = { status, faces, byPostscript };
    if (status !== 'ready' || byPostscript.has(wanted.postscriptName)) return null;
    return { substitute: substituteFor(wanted, catalogue) };
  }, [wanted, status, faces, byPostscript]);
}

interface MissingFontsState {
  /** Transient (never persisted), like `useSourceMissingStore`. */
  missing: MissingFont[];
  /** An open is waiting to be warned about (the catalogue wasn't ready yet). */
  warnPending: boolean;
  warningOpen: boolean;
  /** Wanted fonts + status the list was last computed from; skips no-op recomputes. */
  signature: string;
  setWarningOpen: (open: boolean) => void;
  /** Recomputes `missing` when the text nodes' wanted fonts or the catalogue status changed. */
  recompute: (force?: boolean) => void;
  /** A project just opened: warn once, now or as soon as the catalogue is ready. */
  documentOpened: () => void;
  /** The scene was replaced by an empty one (File → New). */
  documentCleared: () => void;
}

const textNodesOf = (): TextNode[] => useSceneStore.getState().scene.nodes.filter(isTextNode);

function signatureOf(status: string, nodes: readonly TextNode[]): string {
  return `${status}|${nodes.map((n) => `${n.id}:${n.font.postscriptName}`).join(',')}`;
}

export const useMissingFontsStore = create<MissingFontsState>((set, get) => {
  /** Shows the warning once the catalogue can say what is missing. */
  const maybeWarn = () => {
    const { warnPending } = get();
    if (!warnPending) return;
    const { status } = useFontCatalogueStore.getState();
    if (status === 'idle' || status === 'loading') return; // wait for it
    set({ warnPending: false });
    get().recompute(true);
    if (get().missing.length > 0) set({ warningOpen: true });
  };

  const store: MissingFontsState = {
    missing: [],
    warnPending: false,
    warningOpen: false,
    signature: '',
    setWarningOpen: (open) => set({ warningOpen: open }),
    recompute: (force = false) => {
      const catalogue = useFontCatalogueStore.getState();
      const nodes = textNodesOf();
      const signature = signatureOf(catalogue.status, nodes);
      if (!force && signature === get().signature) return;
      set({
        signature,
        missing: catalogue.status === 'ready' ? findMissingFonts(nodes, catalogue.faces) : [],
      });
    },
    documentOpened: () => {
      set({ warnPending: true, warningOpen: false });
      maybeWarn();
    },
    documentCleared: () => set({ warnPending: false, warningOpen: false }),
  };

  // Recompute when the scene's text fonts or the catalogue change; the
  // signature keeps this cheap on the cook scheduler's dirty-flag churn.
  useSceneStore.subscribe(() => get().recompute());
  useFontCatalogueStore.subscribe(() => {
    get().recompute();
    maybeWarn();
  });

  return store;
});
