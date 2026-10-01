import type { FontFamilyGroup } from './catalogue';
import { type FontPreferences, RECENT_LIMIT } from './preferences';

export interface PickerSection {
  id: 'favourites' | 'recent' | 'all' | 'results';
  /** Muted heading; absent for the flat search/favourites-only results list. */
  heading?: string;
  families: FontFamilyGroup[];
}

const byName = (a: FontFamilyGroup, b: FontFamilyGroup) => {
  const x = a.family.toLowerCase();
  const y = b.family.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * What the family picker shows (font-picker-curation.md). `families` is the
 * picker list (Latin-capable families), not the full catalogue.
 *
 * - Empty search: Favourites (A–Z), Recent (most recent first, minus anything
 *   under Favourites, at most 8), All fonts (A–Z). Empty sections are dropped; a
 *   family may appear in Favourites or Recent and also in All fonts.
 * - A search term: one flat A–Z list of matches, starred first, no headings.
 * - `favouritesOnly` keeps only starred families (Favourites alone, or the flat
 *   list when searching).
 */
export function buildPickerSections(
  families: FontFamilyGroup[],
  prefs: FontPreferences,
  search: string,
  favouritesOnly: boolean,
): PickerSection[] {
  const starred = new Set(prefs.favourites.map((f) => f.toLowerCase()));
  const isStarred = (g: FontFamilyGroup) => starred.has(g.family.toLowerCase());
  const sorted = [...families].sort(byName);
  const needle = search.trim().toLowerCase();

  if (needle) {
    const hits = sorted.filter(
      (g) => g.family.toLowerCase().includes(needle) && (!favouritesOnly || isStarred(g)),
    );
    const ordered = [...hits.filter(isStarred), ...hits.filter((g) => !isStarred(g))];
    return ordered.length ? [{ id: 'results', families: ordered }] : [];
  }

  const favourites = sorted.filter(isStarred);
  const sections: PickerSection[] = [];
  if (favourites.length) {
    sections.push({ id: 'favourites', heading: 'Favourites', families: favourites });
  }
  if (favouritesOnly) return sections;

  const byKey = new Map(sorted.map((g) => [g.family.toLowerCase(), g]));
  const recent: FontFamilyGroup[] = [];
  for (const name of prefs.recent) {
    const g = byKey.get(name.toLowerCase());
    if (g && !isStarred(g) && !recent.includes(g)) recent.push(g);
    if (recent.length >= RECENT_LIMIT) break;
  }
  if (recent.length) sections.push({ id: 'recent', heading: 'Recent', families: recent });
  if (sorted.length) sections.push({ id: 'all', heading: 'All fonts', families: sorted });
  return sections;
}
