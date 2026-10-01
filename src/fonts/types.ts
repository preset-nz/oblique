export type FontCategory = 'serif' | 'sans' | 'mono' | 'script' | 'display' | 'symbol' | 'unknown';

/** One installed face, as listed by the Rust `list_fonts` command. */
export interface FontFace {
  family: string;
  style: string;
  postscriptName: string;
  weight: number;
  italic: boolean;
  category: FontCategory;
  /** The face maps all of A–Z a–z. Only the family picker reads it (font-picker-curation.md). */
  latin: boolean;
}

/**
 * What a TextNode stores (Epic 20 README data model). weight/italic/category are
 * captured at pick time so a MISSING font can still be matched against what's installed.
 */
export interface FontRef {
  family: string;
  style: string;
  postscriptName: string;
  weight: number;
  italic: boolean;
  category: FontCategory;
}

/** Picks the FontRef fields explicitly: face-only flags like `latin` must never reach the saved scene. */
export const fontRefOf = (f: FontFace): FontRef => ({
  family: f.family,
  style: f.style,
  postscriptName: f.postscriptName,
  weight: f.weight,
  italic: f.italic,
  category: f.category,
});
