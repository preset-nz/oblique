import { describe, expect, it } from 'vitest';
import { groupFamilies, pickerFamiliesOf } from './catalogue';
import { buildPickerSections } from './pickerSections';
import { type FontPreferences, noteUsedIn } from './preferences';
import { resolveFont } from './resolveFont';
import { face } from './testFixtures';
import { type FontRef, fontRefOf } from './types';

const names = ['Futura', 'Didot', 'Avenir', 'Baskerville', 'Zapfino'];
const families = groupFamilies(names.map((n) => face(n, 'Regular', `${n}-Regular`)));
const prefs = (favourites: string[], recent: string[]): FontPreferences => ({
  version: 1,
  favourites,
  recent,
});
const flat = (sections: ReturnType<typeof buildPickerSections>) =>
  sections.map((s) => [s.heading, s.families.map((g) => g.family)]);

describe('pickerFamilies', () => {
  const faces = [
    face('Helvetica', 'Regular', 'Helvetica'),
    face('Al Bayan', 'Plain', 'AlBayan', 400, 'sans', false),
    face('Mixed', 'Latin', 'Mixed-Latin', 400, 'sans', true),
    face('Mixed', 'Arabic', 'Mixed-Arabic', 700, 'sans', false),
  ];

  it('excludes families with no Latin face, keeps a family with at least one', () => {
    const all = groupFamilies(faces);
    expect(pickerFamiliesOf(all).map((g) => g.family)).toEqual(['Helvetica', 'Mixed']);
    expect(all.map((g) => g.family)).toEqual(['Helvetica', 'Al Bayan', 'Mixed']);
  });

  it('the matcher still resolves a non-Latin font exactly (it sees every face)', () => {
    const wanted: FontRef = {
      family: 'Al Bayan',
      style: 'Plain',
      postscriptName: 'AlBayan',
      weight: 400,
      italic: false,
      category: 'sans',
    };
    const hit = resolveFont(wanted, faces);
    expect(hit?.exact).toBe(true);
    expect(hit?.face.postscriptName).toBe('AlBayan');
  });
});

describe('fontRefOf', () => {
  it('does not leak the face-only latin flag into the saved FontRef', () => {
    expect(Object.keys(fontRefOf(face('A', 'R', 'A-R'))).sort()).toEqual([
      'category',
      'family',
      'italic',
      'postscriptName',
      'style',
      'weight',
    ]);
  });
});

describe('buildPickerSections', () => {
  it('empty search: Favourites, Recent (minus favourites), All fonts, in that order', () => {
    const s = buildPickerSections(
      families,
      prefs(['Futura', 'Avenir'], ['Didot', 'Futura', 'Zapfino']),
      '',
      false,
    );
    expect(flat(s)).toEqual([
      ['Favourites', ['Avenir', 'Futura']],
      ['Recent', ['Didot', 'Zapfino']],
      ['All fonts', ['Avenir', 'Baskerville', 'Didot', 'Futura', 'Zapfino']],
    ]);
  });

  it('a family can be in Favourites and in All fonts', () => {
    const s = buildPickerSections(families, prefs(['Futura'], []), '', false);
    expect(s[0].families.map((g) => g.family)).toEqual(['Futura']);
    expect(s[s.length - 1].families.map((g) => g.family)).toContain('Futura');
  });

  it('omits empty Favourites and Recent sections', () => {
    const s = buildPickerSections(families, prefs([], []), '', false);
    expect(flat(s).map(([h]) => h)).toEqual(['All fonts']);
  });

  it('Recent keeps order, caps at 8, and ignores families not in the list', () => {
    const many = groupFamilies(Array.from({ length: 12 }, (_, i) => face(`F${i}`, 'R', `F${i}`)));
    let p = prefs([], []);
    for (let i = 0; i < 12; i++) p = noteUsedIn(p, `F${i}`);
    p = { ...p, recent: ['Gone', ...p.recent] };
    const recent = buildPickerSections(many, p, '', false).find((s) => s.id === 'recent');
    expect(recent?.families.map((g) => g.family)).toEqual([
      'F11',
      'F10',
      'F9',
      'F8',
      'F7',
      'F6',
      'F5',
      'F4',
    ]);
  });

  it('a search term gives one flat A-Z list, starred first, no headings', () => {
    const s = buildPickerSections(families, prefs(['Zapfino'], ['Didot']), 'A', false);
    expect(s).toHaveLength(1);
    expect(s[0].heading).toBeUndefined();
    // matches "a": Avenir, Baskerville, Futura, Zapfino. Starred first.
    expect(s[0].families.map((g) => g.family)).toEqual([
      'Zapfino',
      'Avenir',
      'Baskerville',
      'Futura',
    ]);
  });

  it('search is trimmed and case-insensitive; no hits gives no sections', () => {
    expect(
      buildPickerSections(families, prefs([], []), '  dID ', false)[0].families.map(
        (g) => g.family,
      ),
    ).toEqual(['Didot']);
    expect(buildPickerSections(families, prefs([], []), 'qqq', false)).toEqual([]);
  });

  it('favourites only: just the starred families, with or without a search', () => {
    const p = prefs(['Futura', 'Didot'], ['Zapfino']);
    expect(flat(buildPickerSections(families, p, '', true))).toEqual([
      ['Favourites', ['Didot', 'Futura']],
    ]);
    const searched = buildPickerSections(families, p, 'u', true);
    expect(searched[0].heading).toBeUndefined();
    expect(searched[0].families.map((g) => g.family)).toEqual(['Futura']);
    expect(buildPickerSections(families, prefs([], []), '', true)).toEqual([]);
  });

  it('a favourite that is not in the picker list is not shown', () => {
    const s = buildPickerSections(families, prefs(['Al Bayan'], []), '', false);
    expect(flat(s).map(([h]) => h)).toEqual(['All fonts']);
  });
});
