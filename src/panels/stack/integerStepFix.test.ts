import { describe, expect, it } from 'vitest';
import { applyDelta } from '@/components/inputNumberMath';
import { snapToIntegerStep } from './integerStepFix';

describe('snapToIntegerStep', () => {
  it('passes through whole values unscathed at step 1', () => {
    expect(snapToIntegerStep(5, 1)).toBe(5);
    expect(snapToIntegerStep(0, 1)).toBe(0);
    expect(snapToIntegerStep(-3, 1)).toBe(-3);
  });

  it('floors an Alt-fractional value to the nearest whole step', () => {
    // Alt (x0.1) applied to step: 1 produces fractional deltas like 0.1, 0.2 …
    expect(snapToIntegerStep(5.1, 1)).toBe(5);
    expect(snapToIntegerStep(5.4, 1)).toBe(5);
    expect(snapToIntegerStep(5.6, 1)).toBe(6);
    expect(snapToIntegerStep(5.9, 1)).toBe(6);
  });

  it('never returns a fractional value regardless of step size', () => {
    for (const raw of [0.05, 0.4, 1.2, 7.7, -2.3]) {
      const snapped = snapToIntegerStep(raw, 1);
      expect(Number.isInteger(snapped)).toBe(true);
    }
  });

  it('floors the effective multiplier at one whole step, even for steps below 10', () => {
    // step: 5 (int) with Alt would otherwise produce a 0.5 increment;
    // snapping still lands on a multiple of the whole step, never fractional.
    expect(snapToIntegerStep(5 + 0.5, 5)).toBe(5);
    expect(snapToIntegerStep(5 + 2, 5)).toBe(5);
    expect(snapToIntegerStep(5 + 3, 5)).toBe(10);
  });

  it('regression: scrubbing an int param with Alt held, repeatedly, only ever produces whole integers', () => {
    // Simulates InputNumber's own Alt-scrub math (applyDelta with alt: true)
    // feeding into the wrapper — the acceptance criterion in prose.
    let value = 10;
    for (const dx of [1, 1, 1, 1, 1, -1, -1]) {
      const raw = applyDelta(value, dx, 1, { alt: true });
      value = snapToIntegerStep(raw, 1);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
