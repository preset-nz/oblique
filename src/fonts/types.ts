export type FontCategory = 'serif' | 'sans' | 'mono' | 'script' | 'display' | 'symbol' | 'unknown';

/** One installed face, as listed by the Rust `list_fonts` command. */
export interface FontFace {
  family: string;
  style: string;
  postscriptName: string;
  weight: number;
  italic: boolean;
  category: FontCategory;
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

export const fontRefOf = (f: FontFace): FontRef => ({ ...f });
