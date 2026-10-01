import type { TextNode } from '@/scene/types';
import { useFontCatalogueStore } from './catalogue';
import { resolveFont } from './resolveFont';
import { type FontFace, type FontRef, fontRefOf } from './types';

/** The slice of the catalogue store the substitution lookup reads. */
export interface CatalogueView {
  status: 'idle' | 'loading' | 'ready' | 'error';
  faces: FontFace[];
  byPostscript: Map<string, FontFace>;
}

/**
 * The installed face standing in for `wanted`, or `null` when `wanted` is
 * installed (or can't be judged: catalogue not ready, or empty). Pure over its
 * arguments; the closest-font pick is `resolveFont` (font-catalogue.md).
 */
export function substituteFor(wanted: FontRef, catalogue: CatalogueView): FontRef | null {
  if (catalogue.status !== 'ready') return null;
  if (catalogue.byPostscript.has(wanted.postscriptName)) return null;
  const hit = resolveFont(wanted, catalogue.faces);
  return hit ? fontRefOf(hit.face) : null;
}

/** Pure form of `effectiveFontFor`: the font `wanted` is shaped with, given a catalogue. */
export function effectiveFont(wanted: FontRef, catalogue: CatalogueView): FontRef {
  return substituteFor(wanted, catalogue) ?? wanted;
}

// `specFor` runs on every cook / hit-test / paint, and a missing font would
// otherwise re-run the matcher over the whole catalogue each time. Keyed on the
// catalogue's faces array identity, so a new catalogue drops the memo wholesale.
let memoFaces: FontFace[] | null = null;
const memo = new Map<string, FontRef | null>();

function memoKey(f: FontRef): string {
  return `${f.postscriptName}|${f.family}|${f.weight}|${f.italic}|${f.category}`;
}

/**
 * The font a text node is actually shaped with (missing-fonts.md). `node.font`
 * stays the WANTED font and is never written; when the catalogue is ready and
 * lacks it, this is the closest installed face instead. EVERY path that turns a
 * text node into a `TextSpec` goes through here.
 */
export function effectiveFontFor(node: TextNode): FontRef {
  const catalogue = useFontCatalogueStore.getState();
  if (catalogue.status !== 'ready') return node.font;
  if (memoFaces !== catalogue.faces) {
    memoFaces = catalogue.faces;
    memo.clear();
  }
  const key = memoKey(node.font);
  let sub = memo.get(key);
  if (sub === undefined) {
    sub = substituteFor(node.font, catalogue);
    memo.set(key, sub);
  }
  return sub ?? node.font;
}
