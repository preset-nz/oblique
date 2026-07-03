import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  applyKeyStep,
  clamp,
  parseCommit,
  roundToStep,
  stepMultiplier,
  stepPrecision,
} from './inputNumberMath';

describe('stepMultiplier', () => {
  it('is 1 with no modifiers', () => {
    expect(stepMultiplier({})).toBe(1);
  });

  it('is 10 with shift', () => {
    expect(stepMultiplier({ shift: true })).toBe(10);
  });

  it('is 0.1 with alt', () => {
    expect(stepMultiplier({ alt: true })).toBe(0.1);
  });

  it('prefers shift when both are held', () => {
    expect(stepMultiplier({ shift: true, alt: true })).toBe(10);
  });
});

describe('stepPrecision', () => {
  it('is 0 for integer steps', () => {
    expect(stepPrecision(1)).toBe(0);
    expect(stepPrecision(5)).toBe(0);
  });

  it('matches the decimal places of fractional steps', () => {
    expect(stepPrecision(0.1)).toBe(1);
    expect(stepPrecision(0.01)).toBe(2);
    expect(stepPrecision(0.25)).toBe(2);
  });

  it('is 0 for a zero step (defensive)', () => {
    expect(stepPrecision(0)).toBe(0);
  });
});

describe('roundToStep', () => {
  it('avoids float dust from repeated 0.1 additions', () => {
    // The classic 0.1 + 0.2 style dust.
    expect(roundToStep(0.1 + 0.2, 0.1)).toBe(0.3);
  });

  it('rounds to the precision implied by an integer step', () => {
    expect(roundToStep(4.6, 1)).toBe(5);
    expect(roundToStep(4.4, 1)).toBe(4);
  });

  it('rounds to the precision implied by a fractional step', () => {
    expect(roundToStep(1.2345, 0.01)).toBe(1.23);
    expect(roundToStep(1.005, 0.01)).toBeCloseTo(1.0, 1);
  });

  it('is a no-op for already-clean values', () => {
    expect(roundToStep(5, 1)).toBe(5);
    expect(roundToStep(0.5, 0.1)).toBe(0.5);
  });
});

describe('clamp', () => {
  it('passes through when within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('tolerates missing min/max', () => {
    expect(clamp(-5, undefined, 10)).toBe(-5);
    expect(clamp(15, 0, undefined)).toBe(15);
    expect(clamp(42)).toBe(42);
  });
});

describe('applyDelta (scrub-drag)', () => {
  it('moves value by step per pixel', () => {
    expect(applyDelta(10, 5, 1)).toBe(15);
    expect(applyDelta(10, -5, 1)).toBe(5);
  });

  it('applies the shift x10 multiplier', () => {
    expect(applyDelta(0, 3, 1, { shift: true })).toBe(30);
  });

  it('applies the alt x0.1 multiplier', () => {
    expect(applyDelta(0, 30, 1, { alt: true })).toBe(3);
  });

  it('scales delta by a fractional step', () => {
    expect(applyDelta(0, 10, 0.1)).toBeCloseTo(1, 9);
  });

  it('clamps to min/max', () => {
    expect(applyDelta(9, 100, 1, {}, 0, 10)).toBe(10);
    expect(applyDelta(1, -100, 1, {}, 0, 10)).toBe(0);
  });

  it('rounds the result to avoid float dust with a 0.1 step', () => {
    const next = applyDelta(0.1, 2, 0.1);
    expect(next).toBe(0.3);
  });

  it('avoids float dust when Alt is combined with a fractional step', () => {
    expect(applyDelta(0, 1, 0.1, { alt: true })).toBe(0.01);
  });
});

describe('applyKeyStep (arrow keys)', () => {
  it('increments by step', () => {
    expect(applyKeyStep(10, 1, 1)).toBe(11);
  });

  it('decrements by step', () => {
    expect(applyKeyStep(10, -1, 1)).toBe(9);
  });

  it('applies shift/alt multipliers', () => {
    expect(applyKeyStep(0, 1, 1, { shift: true })).toBe(10);
    expect(applyKeyStep(0, 1, 1, { alt: true })).toBe(0.1);
  });

  it('avoids float dust when Alt is combined with a fractional step', () => {
    // 0.1 * 0.1 === 0.010000000000000002 in float — must not leak through.
    expect(applyKeyStep(0, 1, 0.1, { alt: true })).toBe(0.01);
    expect(applyKeyStep(0, 1, 0.25, { alt: true })).toBe(0.025);
  });

  it('clamps to min/max', () => {
    expect(applyKeyStep(10, 1, 1, {}, 0, 10)).toBe(10);
    expect(applyKeyStep(0, -1, 1, {}, 0, 10)).toBe(0);
  });
});

describe('parseCommit (typed value on Enter/blur)', () => {
  it('parses a valid numeric string', () => {
    expect(parseCommit('42', 0, 1)).toBe(42);
  });

  it('parses fractional text and rounds to step', () => {
    expect(parseCommit('1.2345', 0, 0.01)).toBe(1.23);
  });

  it('falls back to prev on empty text', () => {
    expect(parseCommit('', 7, 1)).toBe(7);
  });

  it('falls back to prev on non-numeric text', () => {
    expect(parseCommit('abc', 7, 1)).toBe(7);
  });

  it('trims surrounding whitespace', () => {
    expect(parseCommit('  5  ', 0, 1)).toBe(5);
  });

  it('clamps the parsed value to min/max', () => {
    expect(parseCommit('999', 0, 1, 0, 10)).toBe(10);
    expect(parseCommit('-999', 0, 1, 0, 10)).toBe(0);
  });
});
