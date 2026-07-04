/**
 * `InputNumber`'s Alt modifier multiplies `step` by 0.1 unconditionally
 * (`inputNumberMath.stepMultiplier`) — correct for continuous float params,
 * but it goes fractional for integer-typed op params (`grain.seed`,
 * `grain.size` at `step: 1`). The fix belongs to this scope's renderer
 * wiring, not to the shared `InputNumber` component or its generic math
 * module: any value `InputNumber` reports for a field marked
 * `integerStep` gets snapped to the nearest whole multiple of the field's
 * base step before it reaches `onChange`/`write`, so Alt-scrubbing an int
 * param still steps by whole integers, never fractional.
 */
export function snapToIntegerStep(raw: number, step: number): number {
  const wholeStep = Math.max(1, Math.abs(step) || 1);
  return Math.round(raw / wholeStep) * wholeStep;
}
