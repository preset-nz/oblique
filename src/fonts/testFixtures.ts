import type { FontFace, FontRef } from './types';

/** Test-only font helpers shared by the missing-fonts suites. */
export const face = (
  family: string,
  style: string,
  postscriptName: string,
  weight = 400,
  category: FontFace['category'] = 'sans',
): FontFace => ({ family, style, postscriptName, weight, italic: false, category });

export const BLACKLETTER_BOLD: FontRef = {
  family: 'Blackletter Grim',
  style: 'Bold',
  postscriptName: 'BlackletterGrim-Bold',
  weight: 700,
  italic: false,
  category: 'serif',
};

export const INSTALLED: FontFace[] = [
  face('Helvetica Neue', 'Regular', 'HelveticaNeue'),
  face('Helvetica Neue', 'Bold', 'HelveticaNeue-Bold', 700),
  face('Times New Roman', 'Regular', 'TimesNewRomanPSMT', 400, 'serif'),
  face('Times New Roman', 'Bold', 'TimesNewRomanPS-BoldMT', 700, 'serif'),
];
