import { describe, expect, it } from 'vitest';
import { defaultFontRef, resolveFont } from './resolveFont';
import { type FontCategory, type FontFace, type FontRef, fontRefOf } from './types';

const face = (
  family: string,
  postscriptName: string,
  weight = 400,
  italic = false,
  category: FontCategory = 'sans',
): FontFace => ({
  family,
  style: 'x',
  postscriptName,
  weight,
  italic,
  category,
  latin: true,
});

const wantedOf = (f: FontFace): FontRef => fontRefOf(f);

const helv = [
  face('Helvetica Neue', 'HelveticaNeue-Light', 300),
  face('Helvetica Neue', 'HelveticaNeue', 400),
  face('Helvetica Neue', 'HelveticaNeue-Italic', 400, true),
  face('Helvetica Neue', 'HelveticaNeue-Bold', 700),
];

describe('resolveFont', () => {
  it('returns an exact PostScript hit', () => {
    const r = resolveFont(wantedOf(helv[3]), helv);
    expect(r?.exact).toBe(true);
    expect(r?.face.postscriptName).toBe('HelveticaNeue-Bold');
  });

  it('picks the nearest weight in the same family, case-insensitively, matching italic', () => {
    const wanted = { ...wantedOf(face('HELVETICA NEUE', 'Gone-Semibold', 600)) };
    const r = resolveFont(wanted, helv);
    expect(r).toEqual({ face: helv[3], exact: false });
  });

  it('lets an italic mismatch lose to a farther weight that matches italic', () => {
    const faces = [face('Fam', 'Fam-Regular', 400), face('Fam', 'Fam-BoldItalic', 700, true)];
    const wanted = wantedOf(face('Fam', 'Fam-Italic', 400, true));
    expect(resolveFont(wanted, faces)?.face.postscriptName).toBe('Fam-BoldItalic');
  });

  it('falls back to the category preferred family when the family is missing', () => {
    const faces = [
      ...helv,
      face('Zapfino', 'Zapfino', 400, false, 'script'),
      face('Times', 'Times-Roman', 400, false, 'serif'),
      face('Times New Roman', 'TimesNewRomanPSMT', 400, false, 'serif'),
      face('Times New Roman', 'TimesNewRomanPS-BoldMT', 700, false, 'serif'),
    ];
    const wanted = wantedOf(face('Garamond', 'Garamond-Bold', 700, false, 'serif'));
    expect(resolveFont(wanted, faces)).toEqual({ face: faces[7], exact: false });
  });

  it('uses the second preferred family when the first is not installed', () => {
    const faces = [...helv, face('Times', 'Times-Roman', 400, false, 'serif')];
    const wanted = wantedOf(face('Garamond', 'Garamond', 400, false, 'serif'));
    expect(resolveFont(wanted, faces)?.face.postscriptName).toBe('Times-Roman');
  });

  it('sends display, symbol and unknown to the sans list', () => {
    for (const category of ['display', 'symbol', 'unknown'] as const) {
      const wanted = wantedOf(face('Nope', 'Nope', 400, false, category));
      expect(resolveFont(wanted, helv)?.face.postscriptName).toBe('HelveticaNeue');
    }
  });

  it('takes the best face of the category, ties by family name, when no preferred family is installed', () => {
    const faces = [
      face('Zeta Serif', 'Zeta-Regular', 400, false, 'serif'),
      face('Alpha Serif', 'Alpha-Regular', 400, false, 'serif'),
      face('Beta Sans', 'Beta-Regular', 400, false, 'sans'),
    ];
    const wanted = wantedOf(face('Missing', 'Missing', 400, false, 'serif'));
    expect(resolveFont(wanted, faces)?.face.postscriptName).toBe('Alpha-Regular');
  });

  it('falls to the sans list, then the first face, when the category has no faces', () => {
    const wanted = wantedOf(face('Missing', 'Missing', 400, false, 'script'));
    expect(resolveFont(wanted, helv)?.face.postscriptName).toBe('HelveticaNeue');
    const odd = [
      face('Odd B', 'OddB', 400, false, 'mono'),
      face('Odd A', 'OddA', 400, false, 'mono'),
    ];
    expect(resolveFont(wanted, odd)?.face.postscriptName).toBe('OddB');
  });

  it('returns null for an empty list', () => {
    expect(resolveFont(wantedOf(helv[0]), [])).toBeNull();
  });

  it('is deterministic', () => {
    const wanted = wantedOf(face('Missing', 'Missing', 550, true, 'serif'));
    const a = resolveFont(wanted, helv);
    expect(resolveFont(wanted, helv)).toEqual(a);
    expect(resolveFont(wanted, [...helv].reverse())).toEqual(a);
  });
});

describe('defaultFontRef', () => {
  it('resolves Helvetica Neue Regular when installed', () => {
    expect(defaultFontRef(helv).postscriptName).toBe('HelveticaNeue');
  });

  it('returns the synthetic ref when no faces are available', () => {
    expect(defaultFontRef([])).toEqual({
      family: 'Helvetica Neue',
      style: 'Regular',
      postscriptName: 'HelveticaNeue',
      weight: 400,
      italic: false,
      category: 'sans',
    });
  });
});
