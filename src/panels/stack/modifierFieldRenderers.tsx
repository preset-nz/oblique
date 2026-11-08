import { type FieldDef, type FieldRenderer, registerFieldRenderer } from '@preset.nz/facets';
import { Icons } from '@preset.nz/ux-kit';
import {
  CurveEditor,
  type CurveEditorProps,
  constrainLevels,
  Histogram,
  type Levels,
  levelsCurve,
  levelsLine,
  levelsOf,
} from '@preset.nz/ux-kit/graphics';
import { useEffect, useId, useMemo, useRef } from 'react';
import { InputNumber } from '@/components/InputNumber';
import { LabelTip } from '@/components/LabelTip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useCacheVersionStore } from '@/scene/cache';
import { useEyedropperStore } from '@/scene/eyedropperState';
import { getHistogram } from '@/scene/histograms';
import { beginTransaction, cancelTransaction, endTransaction } from '@/scene/transaction';
import { snapToIntegerStep } from './integerStepFix';
import type {
  CurveEnd,
  CurveValue,
  ModifierColorFieldDef,
  ModifierCurveFieldDef,
  ModifierNumberFieldDef,
  ModifierSelectFieldDef,
  ModifierSliderFieldDef,
} from './modifierScope';

/**
 * Wraps a field's `onChange` so int-typed (`integerStep`) fields always
 * commit whole-step values — see `integerStepFix.ts` for why this can't
 * live in `InputNumber` itself.
 */
function wrapIntegerAware(
  onChange: ((next: unknown) => void) | undefined,
  step: number,
  integerStep: boolean | undefined,
): ((next: number) => void) | undefined {
  if (!onChange) return undefined;
  if (!integerStep) return (next: number) => onChange(next);
  return (next: number) => onChange(snapToIntegerStep(next, step));
}

const ModifierNumberRenderer: FieldRenderer<ModifierNumberFieldDef> = ({
  field,
  value,
  disabled,
  onChange,
}) => {
  const step = field.step ?? 1;
  const numeric = typeof value === 'number' ? value : Number(value) || 0;
  const wrapped = wrapIntegerAware(onChange, step, field.integerStep);
  // Optional tooltip for number fields that carry a unit note (the Text
  // inspector's tracking: "1/1000 em"). Extra props aren't type-checked by facets.
  const hint = (field as { hint?: string }).hint;
  const input = (
    <InputNumber
      label={field.label ?? field.id}
      description={field.description}
      value={numeric}
      onChange={wrapped ?? (() => {})}
      min={field.min}
      max={field.max}
      step={step}
      disabled={disabled || !wrapped}
      // Dogfood fix: op param spec maxes are conservative guesses — a
      // scrub still clamps to the spec range, but a typed value can go
      // beyond it (Blender-style soft max).
      allowTypedOverMax
      onDragStart={beginTransaction}
      onDragEnd={endTransaction}
    />
  );
  return hint ? <div title={hint}>{input}</div> : input;
};

const ModifierSliderRenderer: FieldRenderer<ModifierSliderFieldDef> = ({
  field,
  value,
  disabled,
  onChange,
}) => {
  const step = field.step ?? 1;
  const numeric = typeof value === 'number' ? value : Number(value) || (field.min ?? 0);
  const wrapped = wrapIntegerAware(onChange, step, field.integerStep);
  const readOnly = disabled || !wrapped;
  return (
    <div className="flex flex-col gap-1">
      <LabelTip description={field.description}>
        <span
          className={cn(
            'w-fit text-[11px] font-medium text-muted-foreground tracking-wide',
            readOnly && 'opacity-50',
          )}
        >
          {field.label ?? field.id}
        </span>
      </LabelTip>
      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label={field.label ?? field.id}
          value={numeric}
          min={field.min}
          max={field.max}
          step={step}
          disabled={readOnly}
          onChange={(e) => wrapped?.(Number(e.target.value))}
          // Undo/history transaction boundary (Epic 13): a native range fires
          // onChange continuously while dragged, so pointerdown/pointerup are
          // this control's version of InputNumber's scrub-drag lifecycle —
          // one drag coalesces into one undo step.
          onPointerDown={() => beginTransaction()}
          onPointerUp={() => endTransaction()}
          className="flex-1 disabled:opacity-50"
        />
        {/* Slider drag and InputNumber scrub live on the same row, sharing one value. */}
        <InputNumber
          label=""
          value={numeric}
          onChange={wrapped ?? (() => {})}
          min={field.min}
          max={field.max}
          step={step}
          disabled={readOnly}
          className="w-auto"
          allowTypedOverMax
          onDragStart={beginTransaction}
          onDragEnd={endTransaction}
        />
      </div>
    </div>
  );
};

/**
 * Enum op params render as a `ToggleGroup` segmented control rather than
 * the shared package's `select` dropdown (op enums are short lists — the
 * story's explicit design note: a segmented control reads faster than a
 * dropdown open/close). Registered for the `select` kind, overriding the
 * shared package's plain `<Select>` builtin the same way the number/slider
 * renderers override theirs.
 */
const ModifierSelectRenderer: FieldRenderer<ModifierSelectFieldDef> = ({
  field,
  value,
  disabled,
  onChange,
}) => {
  const options = field.options ?? [];
  const current = value == null ? '' : String(value);
  const readOnly = disabled || !onChange;
  return (
    <div className="flex flex-col gap-1">
      <LabelTip description={field.description}>
        <span
          className={cn(
            'w-fit text-[11px] font-medium text-muted-foreground tracking-wide',
            readOnly && 'opacity-50',
          )}
        >
          {field.label ?? field.id}
        </span>
      </LabelTip>
      <ToggleGroup
        size="sm"
        spacing={0}
        value={[current]}
        disabled={readOnly}
        onValueChange={([next]) => {
          if (next) onChange?.(next);
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} className="text-xs px-2">
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
};

/**
 * Pipette beside a colour swatch (eyedropper.md): arms a one-shot canvas pick
 * through `eyedropperState`, whose `onPick` is the field's own `onChange` —
 * one write, one undo step. A real component (not inline in the renderer)
 * because facets calls renderers as plain functions, so hooks must live here.
 *
 * `fieldKey` comes from `useId`: the facets renderer receives no node/modifier
 * ids (`ctx` is only the key of the modifier's cooked extras, `histogramKey`, and the
 * selection never reaches the renderer), but every mounted field instance gets its own id, which is
 * exactly the uniqueness the active state needs. Unmounting (row collapsed,
 * node deleted) while armed cancels the pick rather than leaving it dangling.
 */
function EyedropperButton({
  onChange,
  disabled,
}: {
  onChange?: (next: unknown) => void;
  disabled: boolean;
}) {
  const fieldKey = useId();
  const active = useEyedropperStore((s) => s.armed?.fieldKey === fieldKey);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(
    () => () => {
      const { armed, disarm } = useEyedropperStore.getState();
      if (armed?.fieldKey === fieldKey) disarm();
    },
    [fieldKey],
  );

  // A field that becomes read-only (layer locked) mid-pick drops the pick.
  useEffect(() => {
    if (!disabled) return;
    const { armed, disarm } = useEyedropperStore.getState();
    if (armed?.fieldKey === fieldKey) disarm();
  }, [disabled, fieldKey]);

  const toggle = () => {
    const store = useEyedropperStore.getState();
    if (store.armed?.fieldKey === fieldKey) {
      store.disarm();
      return;
    }
    store.arm({ fieldKey, onPick: (hex) => onChangeRef.current?.(hex) });
  };

  return (
    <LabelTip description="Pick from canvas">
      <button
        type="button"
        aria-label="Pick from canvas"
        aria-pressed={active}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-neutral-200 disabled:cursor-not-allowed',
          active && 'text-sky-400 hover:text-sky-400',
        )}
      >
        <Icons.EyedropperIcon size={14} />
      </button>
    </LabelTip>
  );
}

/**
 * Colour op params render as a native `<input type="color">` swatch plus a
 * read-only hex readout, matching the in-app precedent for the document
 * background colour control (`DocumentFields.tsx`) rather than the shared
 * package's plain text-input `ColorRenderer` builtin. Registered for the
 * `color` kind, overriding that builtin the same way the number/slider/select
 * renderers override theirs.
 */
const ModifierColorRenderer: FieldRenderer<ModifierColorFieldDef> = ({
  field,
  value,
  disabled,
  onChange,
}) => {
  const hex = typeof value === 'string' && value.length > 0 ? value : '#000000';
  const readOnly = disabled || !onChange;
  return (
    <div className="flex flex-col gap-1">
      <LabelTip description={field.description}>
        <span
          className={cn(
            'w-fit text-[11px] font-medium text-muted-foreground tracking-wide',
            readOnly && 'opacity-50',
          )}
        >
          {field.label ?? field.id}
        </span>
      </LabelTip>
      <div className={cn('flex items-center gap-2', readOnly && 'opacity-50')}>
        <input
          type="color"
          aria-label={field.label ?? field.id}
          value={hex}
          disabled={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          // Undo/history transaction boundary (Epic 13): a native colour
          // input fires onChange continuously while the OS picker is open,
          // so focus/blur are this control's version of the slider
          // renderer's pointerdown/pointerup pair — one picker session
          // coalesces into one undo step.
          onFocus={() => beginTransaction()}
          onBlur={() => endTransaction()}
          className="h-6 w-8 cursor-pointer rounded border border-neutral-700 bg-transparent disabled:cursor-not-allowed"
        />
        <EyedropperButton onChange={onChange} disabled={readOnly} />
        <span className="font-mono text-xs text-muted-foreground">{hex}</span>
      </div>
    </div>
  );
};

/** The curve type ux-kit's editor hands back (it is math's `Curve`, which ux-kit doesn't re-export). */
type Curve = Parameters<CurveEditorProps['onChange']>[0];

/** A number the curve can draw, else `fallback` (a value the document holds that is not a number). */
function usable(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `value` rounded to `step` from `min`, held to `[min, max]`: what an end drag writes (black and white are whole levels). */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  const snapped = Math.round((value - min) / step) * step + min;
  return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
}

/** The gamma a curve edit writes, to three places: the point sits on a pixel grid anyway, and a file shouldn't carry 1.2345678901. */
export function roundGamma(g: number): number {
  return Math.round(g * 1000) / 1000;
}

/**
 * The curve field's value as the editor draws it: black and white put on the 0..1 axis by their
 * own params' ranges (not a hardcoded 255), and gamma, held to a usable number (else 1, the
 * diagonal). A value that is not a curve value draws the identity: ends at the params' defaults
 * of min and max.
 */
export function levelsToDraw(field: ModifierCurveFieldDef, value: unknown): Levels {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<CurveValue>;
  const norm = (end: CurveEnd, raw: unknown, fallback: number) =>
    (usable(raw, fallback) - end.min) / (end.max - end.min);
  const gamma = usable(v.gamma, 1);
  return {
    black: norm(field.black, v.black, field.black.min),
    white: norm(field.white, v.white, field.white.max),
    gamma: gamma > 0 ? gamma : 1,
  };
}

/**
 * What a curve edit writes: `current` with only the keys the edit changed replaced, black and
 * white rounded to their params' steps and gamma to three places. The comparison is on the
 * un-rounded numbers, with the editor's own tolerance, so dragging an end (which carries the
 * gamma point along without changing its height) never writes gamma, and a gamma typed to more
 * places than three is not rewritten by it. `null` for a curve that is not a levels curve.
 */
export function valueFromCurve(
  field: ModifierCurveFieldDef,
  current: CurveValue,
  next: Curve,
): CurveValue | null {
  const l = levelsOf(next);
  if (!l || !Number.isFinite(l.gamma) || l.gamma <= 0) return null;
  // as the editor holds it: its ends are kept apart, so a typed black above white compares clamped
  const was = levelsOf(levelsCurve(levelsToDraw(field, current)));
  if (!was) return null;
  const out = { ...current };
  const unit = (end: CurveEnd, x: number) =>
    snapToStep(end.min + x * (end.max - end.min), end.min, end.max, end.step);
  if (Math.abs(l.black - was.black) > 1e-9) out.black = unit(field.black, l.black);
  if (Math.abs(l.white - was.white) > 1e-9) out.white = unit(field.white, l.white);
  if (Math.abs(l.gamma - was.gamma) > 1e-9) out.gamma = roundGamma(l.gamma);
  return out;
}

/**
 * Levels as the Gamma number field with a curve under it, over a histogram of levels' input
 * (levels-curve.md): dragging the point writes gamma, dragging an end writes black or white, and
 * typing in Black point, White point or Gamma moves the curve. The field's value is
 * `{black, white, gamma}` (`modifierScope.ts` reads it from the three params and writes back only
 * what changed). A real component because facets calls renderers as plain functions and this one
 * has hooks.
 *
 * A drag is one undo step the way a field scrub is: `beginTransaction` when it starts,
 * `endTransaction` when it ends, and `cancelTransaction` when Escape abandons it (the editor has
 * already put the curve back by then). Arrow-key nudges and menu edits are single writes.
 */
function LevelsCurveField({
  field,
  value,
  disabled,
  onChange,
  histogramKey,
}: {
  field: ModifierCurveFieldDef;
  value: unknown;
  disabled: boolean;
  onChange?: (next: unknown) => void;
  histogramKey: unknown;
}) {
  const levels = levelsToDraw(field, value);
  const min = field.min ?? 0.1;
  const max = field.max ?? 5;
  const readOnly = disabled || !onChange;
  const constrain = useMemo(() => constrainLevels(min, max), [min, max]);
  // the bins live in the cache map; a cook writing them bumps this version
  useCacheVersionStore((s) => s.cacheVersion);
  const bins = typeof histogramKey === 'string' ? getHistogram(histogramKey) : undefined;
  const background = useMemo(
    () =>
      bins ? <Histogram bins={bins} aria-label="Histogram of the picture reaching levels" /> : null,
    [bins],
  );
  // the value as the scope read it, in the params' units
  const current: CurveValue = {
    black: usable((value as Partial<CurveValue> | null)?.black, field.black.min),
    white: usable((value as Partial<CurveValue> | null)?.white, field.white.max),
    gamma: levels.gamma,
  };
  const write = (next: Curve) => {
    const written = valueFromCurve(field, current, next);
    if (written) onChange?.(written);
  };
  const label = field.label ?? field.id;
  return (
    <div className="flex flex-col gap-2">
      <InputNumber
        label={label}
        description={field.description}
        value={levels.gamma}
        onChange={(next) => onChange?.({ ...current, gamma: next })}
        min={field.min}
        max={field.max}
        step={field.step ?? 0.05}
        disabled={readOnly}
        allowTypedOverMax
        onDragStart={beginTransaction}
        onDragEnd={endTransaction}
      />
      <div
        className={cn('w-full', readOnly && 'opacity-50')}
        // a locked layer (or a field with no write) shows the curve and ignores it
        inert={readOnly}
      >
        <CurveEditor
          value={levelsCurve(levels)}
          onChange={write}
          onGestureStart={beginTransaction}
          onGestureEnd={(committed) => (committed ? endTransaction() : cancelTransaction())}
          constrain={constrain}
          line={levelsLine}
          background={background}
          aria-label="Levels curve"
          className="aspect-square h-auto w-full"
        />
      </div>
    </div>
  );
}

/**
 * A float param the op's backend draws as a curve (`widget: 'curve'` with its `curve` ends): the
 * curve plus the param's number field. `ctx` is the modifier's histogram key (`StackRow`).
 */
const ModifierCurveRenderer: FieldRenderer<ModifierCurveFieldDef> = ({
  field,
  value,
  disabled,
  onChange,
  ctx,
}) => (
  <LevelsCurveField
    field={field}
    value={value}
    disabled={disabled}
    onChange={onChange}
    histogramKey={ctx}
  />
);

/**
 * Registers Oblique's `number`/`slider`/`select`/`color`/`curve` renderers, overriding the
 * shared package's plain-`<input>`/`<select>` builtins with the scrub-drag
 * `InputNumber` and the `ToggleGroup` segmented control. Call once at app
 * start, after `registerBuiltinRenderers()`.
 */
export function registerModifierFieldRenderers(): void {
  registerFieldRenderer('number', ModifierNumberRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('slider', ModifierSliderRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('select', ModifierSelectRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('color', ModifierColorRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('curve', ModifierCurveRenderer as FieldRenderer<FieldDef>);
}
