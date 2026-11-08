import { useCacheVersionStore } from '@/scene/cache';

/**
 * 256-bin counts of a picture, as the sidecar sends them (`handlers/cook.py`, `histogram_bins`).
 * `luma` is Rec. 709; the arrays are plain numbers, what ux-kit's `Histogram` takes as `bins`.
 */
export interface HistogramBins {
  luma: number[];
  r: number[];
  g: number[];
  b: number[];
}

/**
 * The histogram of the picture that reached a modifier on its last draft cook, by `histogramKey`
 * (levels draws it behind its curve). Module-scope like the bitmap cache and for the same
 * reason: it is derived from pixels and mutates on every cook, so it never goes in the scene,
 * which stays JSON. Writes bump `useCacheVersionStore`, which the panel subscribes to.
 *
 * A cook that resumes from a stored prefix past the modifier doesn't send bins, and the entry
 * stays: that prefix is the modifier's input, unchanged.
 */
const bins = new Map<string, HistogramBins>();

/**
 * The key a modifier's histogram is filed under: its layer and its id. The id alone is enough in
 * a document the app made, but a modifier is addressed by layer and id (`/layers/<layer>/<id>`)
 * everywhere else, so this doesn't lean on ids being unique across layers.
 */
export function histogramKey(nodeId: string, modifierId: string): string {
  return `${nodeId}/${modifierId}`;
}

export function getHistogram(key: string): HistogramBins | undefined {
  return bins.get(key);
}

export function setHistogram(key: string, value: HistogramBins): void {
  bins.set(key, value);
  useCacheVersionStore.getState().bump();
}

/** Drop every histogram (a different document was opened). */
export function clearAllHistograms(): void {
  bins.clear();
  useCacheVersionStore.getState().bump();
}

/** The wire shape of one response entry, validated: 256 finite counts in each channel, else `undefined`. */
export function histogramFromWire(entry: unknown): HistogramBins | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  const channel = (v: unknown): number[] | undefined =>
    Array.isArray(v) && v.length === 256 && v.every((n) => Number.isFinite(n))
      ? (v as number[])
      : undefined;
  const luma = channel(e.luma);
  const r = channel(e.r);
  const g = channel(e.g);
  const b = channel(e.b);
  return luma && r && g && b ? { luma, r, g, b } : undefined;
}

/**
 * Files the `histograms` of a cook response under the modifiers that asked: each entry's
 * `modifierIndex` is an index into the request's `modifiers`, whose `histogramFor` is the key.
 * An entry that names no asking modifier, or isn't 256 counts in four channels, is dropped.
 */
export function storeResponseHistograms(
  histograms: unknown,
  asked: readonly { histogramFor?: string }[],
): void {
  if (!Array.isArray(histograms)) return;
  for (const entry of histograms as { modifierIndex?: unknown }[]) {
    const key =
      typeof entry?.modifierIndex === 'number'
        ? asked[entry.modifierIndex]?.histogramFor
        : undefined;
    const value = key ? histogramFromWire(entry) : undefined;
    if (key && value) setHistogram(key, value);
  }
}
