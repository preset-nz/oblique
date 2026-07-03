/**
 * Pure logic for InputNumber — scrub-drag delta math, typed-value commit
 * parsing, and step-precision rounding. Kept dependency-free so it can be
 * unit-tested without a DOM.
 */

export interface Modifiers {
  shift?: boolean;
  alt?: boolean;
}

/** Multiplier applied to the per-pixel/per-keypress step given held modifiers. */
export function stepMultiplier(mods: Modifiers): number {
  if (mods.shift) return 10;
  if (mods.alt) return 0.1;
  return 1;
}

/** Number of decimal places implied by `step` (e.g. 0.1 -> 1, 5 -> 0). */
export function stepPrecision(step: number): number {
  if (!Number.isFinite(step) || step === 0) return 0;
  const s = Math.abs(step).toString();
  if (s.includes('e-')) {
    // Handle scientific notation like 1e-7.
    const [, exp] = s.split('e-');
    return Number(exp);
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Rounds `value` to the precision implied by `step`, avoiding float dust. */
export function roundToStep(value: number, step: number): number {
  return roundToPrecision(value, stepPrecision(step));
}

function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Decimal-place precision for a step under a modifier multiplier. Derived
 * from the *nominal* step's precision, not `step * multiplier` — that
 * product is itself a float with its own dust (e.g. `0.1 * 0.1 ===
 * 0.010000000000000002`), which would defeat the rounding it's meant to
 * drive. Alt (x0.1) adds exactly one decimal place; Shift (x10) never adds
 * any (it only makes the value coarser).
 */
function effectivePrecision(step: number, mods: Modifiers): number {
  const base = stepPrecision(step);
  return mods.alt && !mods.shift ? base + 1 : base;
}

/** Clamps `value` into [min, max], tolerating either bound being undefined. */
export function clamp(value: number, min?: number, max?: number): number {
  let v = value;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

/**
 * Applies a scrub-drag delta (in screen pixels) to `value`, honouring
 * `step` per pixel and the Shift (x10) / Alt (x0.1) modifiers, then clamps
 * and rounds to step precision.
 */
export function applyDelta(
  value: number,
  pixels: number,
  step: number,
  mods: Modifiers = {},
  min?: number,
  max?: number,
): number {
  // Round to the *effective* precision (after the Shift/Alt multiplier), not
  // the nominal step's — otherwise Alt's finer granularity would be
  // discarded by rounding to the nominal step's coarser decimal precision.
  const delta = pixels * step * stepMultiplier(mods);
  return roundToPrecision(clamp(value + delta, min, max), effectivePrecision(step, mods));
}

/**
 * Applies a single keyboard increment/decrement (ArrowUp/ArrowDown) of
 * `direction` (+1 / -1) by `step`, honouring modifiers, then clamps and
 * rounds to step precision.
 */
export function applyKeyStep(
  value: number,
  direction: 1 | -1,
  step: number,
  mods: Modifiers = {},
  min?: number,
  max?: number,
): number {
  const delta = direction * step * stepMultiplier(mods);
  return roundToPrecision(clamp(value + delta, min, max), effectivePrecision(step, mods));
}

/**
 * Parses free-typed text on commit (Enter/blur). Returns `prev` unchanged
 * if the text does not parse as a finite number; otherwise clamps and
 * rounds the parsed value to `step` precision.
 */
export function parseCommit(
  text: string,
  prev: number,
  step: number,
  min?: number,
  max?: number,
): number {
  const trimmed = text.trim();
  if (trimmed === '') return prev;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return prev;
  return roundToStep(clamp(parsed, min, max), step);
}
