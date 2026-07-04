/** Pure aspect/orientation maths for document setup — no store, no React. */

export type Orientation = 'landscape' | 'portrait';

export interface AspectPreset {
  id: string;
  label: string;
  /** Long-edge : short-edge ratio, always >= 1. */
  ratio: number;
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '16:10', label: '16:10', ratio: 16 / 10 },
  { id: '1:2', label: '1:2', ratio: 2 },
];

/** Long-edge pixel size to use for an empty document (no existing size to derive from). */
export const DEFAULT_LONG_EDGE = 2048;

/** The longer of a document size's two edges — falls back to the default for an empty/zero doc. */
export function longEdgeOf(documentSize: [number, number]): number {
  const [w, h] = documentSize;
  if (w <= 0 || h <= 0) return DEFAULT_LONG_EDGE;
  return Math.max(w, h);
}

/**
 * Derive a document size from a long edge, an aspect ratio (long:short,
 * ratio >= 1), and an orientation. Landscape puts the long edge on width;
 * portrait puts it on height. 1:1 (ratio 1) is orientation-invariant.
 */
export function computeDocumentSize(
  longEdge: number,
  ratio: number,
  orientation: Orientation,
): [number, number] {
  const shortEdge = Math.max(1, Math.round(longEdge / ratio));
  const long = Math.max(1, Math.round(longEdge));
  return orientation === 'landscape' ? [long, shortEdge] : [shortEdge, long];
}

/**
 * Next document size when the user picks a new preset/orientation for the
 * *current* document (or an empty one) — derives the long edge from the
 * current size (or the default), per the story ("derive pixel size from
 * the current documentSize's long edge, or a sensible default").
 */
export function nextDocumentSize(
  currentSize: [number, number],
  preset: AspectPreset,
  orientation: Orientation,
): [number, number] {
  return computeDocumentSize(longEdgeOf(currentSize), preset.ratio, orientation);
}

/** Which preset (by id) and orientation best describe a given document size — for UI display. */
export function describeDocumentSize(documentSize: [number, number]): {
  presetId: string | null;
  orientation: Orientation;
} {
  const [w, h] = documentSize;
  if (w <= 0 || h <= 0) return { presetId: null, orientation: 'landscape' };

  const orientation: Orientation = w >= h ? 'landscape' : 'portrait';
  const ratio = orientation === 'landscape' ? w / h : h / w;

  let bestId: string | null = null;
  let bestDelta = Infinity;
  for (const preset of ASPECT_PRESETS) {
    const delta = Math.abs(preset.ratio - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestId = preset.id;
    }
  }
  // Loose tolerance — this is a display hint, not a strict match; an
  // arbitrary imported size just shows no highlighted preset.
  return { presetId: bestDelta < 0.02 ? bestId : null, orientation };
}
