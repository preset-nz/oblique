import type { FontCategory, FontFace, FontRef } from './types';
import { fontRefOf } from './types';

const SANS_PREFERRED = ['Helvetica Neue', 'Helvetica'];

const PREFERRED_FAMILIES: Record<FontCategory, string[]> = {
  serif: ['Times New Roman', 'Times'],
  sans: SANS_PREFERRED,
  mono: ['Menlo', 'Courier New'],
  script: ['Snell Roundhand'],
  display: SANS_PREFERRED,
  symbol: SANS_PREFERRED,
  unknown: SANS_PREFERRED,
};

/** Lower is better. */
function score(face: FontFace, wanted: FontRef): number {
  return Math.abs(face.weight - wanted.weight) + (face.italic !== wanted.italic ? 1000 : 0);
}

/** Best-scoring face; ties go to the lower family (when `tieByFamily`), then PostScript name. */
function best(faces: FontFace[], wanted: FontRef, tieByFamily = false): FontFace | null {
  let winner: FontFace | null = null;
  let winnerScore = Number.POSITIVE_INFINITY;
  for (const face of faces) {
    const s = score(face, wanted);
    let better = s < winnerScore;
    if (!better && winner && s === winnerScore) {
      const byFamily = tieByFamily ? face.family.localeCompare(winner.family) : 0;
      better =
        byFamily < 0 ||
        (byFamily === 0 && face.postscriptName.localeCompare(winner.postscriptName) < 0);
    }
    if (better) {
      winner = face;
      winnerScore = s;
    }
  }
  return winner;
}

const inFamily = (faces: FontFace[], family: string): FontFace[] => {
  const key = family.toLowerCase();
  return faces.filter((f) => f.family.toLowerCase() === key);
};

/**
 * Pure, deterministic closest-font matcher (Epic 20 font-catalogue story).
 * exact PostScript name, then same family, then the category's preferred family,
 * then the sans list, then anything. `null` only when `faces` is empty.
 */
export function resolveFont(
  wanted: FontRef,
  faces: FontFace[],
): { face: FontFace; exact: boolean } | null {
  if (faces.length === 0) return null;

  const exact = faces.find((f) => f.postscriptName === wanted.postscriptName);
  if (exact) return { face: exact, exact: true };

  const sameFamily = best(inFamily(faces, wanted.family), wanted);
  if (sameFamily) return { face: sameFamily, exact: false };

  for (const family of PREFERRED_FAMILIES[wanted.category]) {
    const hit = best(inFamily(faces, family), wanted);
    if (hit) return { face: hit, exact: false };
  }
  const sameCategory = best(
    faces.filter((f) => f.category === wanted.category),
    wanted,
    true,
  );
  if (sameCategory) return { face: sameCategory, exact: false };

  const sansFaces = faces.filter((f) =>
    SANS_PREFERRED.some((family) => family.toLowerCase() === f.family.toLowerCase()),
  );
  return { face: best(sansFaces, wanted) ?? faces[0], exact: false };
}

const DEFAULT_WANTED: FontRef = {
  family: 'Helvetica Neue',
  style: 'Regular',
  postscriptName: 'HelveticaNeue',
  weight: 400,
  italic: false,
  category: 'sans',
};

/** The font the text tool places with. */
export function defaultFontRef(faces: FontFace[]): FontRef {
  const hit = resolveFont(DEFAULT_WANTED, faces);
  return hit ? fontRefOf(hit.face) : { ...DEFAULT_WANTED };
}
