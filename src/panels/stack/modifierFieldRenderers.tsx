import { type FieldDef, type FieldRenderer, registerFieldRenderer } from '@preset.nz/facets';
import { Pipette } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { InputNumber } from '@/components/InputNumber';
import { LabelTip } from '@/components/LabelTip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useEyedropperStore } from '@/scene/eyedropperState';
import { beginTransaction, endTransaction } from '@/scene/history';
import { snapToIntegerStep } from './integerStepFix';
import type {
  ModifierColorFieldDef,
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
        type="single"
        size="sm"
        spacing={0}
        value={current}
        disabled={readOnly}
        onValueChange={(next) => {
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
 * ids (`ctx` is `null` for the modifier scope and the selection never reaches
 * the renderer), but every mounted field instance gets its own id, which is
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
        <Pipette size={14} />
      </button>
    </LabelTip>
  );
}

/**
 * Colour op params render as a native `<input type="color">` swatch plus a
 * read-only hex readout, matching the in-app precedent for the document
 * background colour control (`DocumentSetup.tsx`) rather than the shared
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

/**
 * Registers Oblique's `number`/`slider`/`select`/`color` renderers, overriding the
 * shared package's plain-`<input>`/`<select>` builtins with the scrub-drag
 * `InputNumber` and the `ToggleGroup` segmented control. Call once at app
 * start, after `registerBuiltinRenderers()`.
 */
export function registerModifierFieldRenderers(): void {
  registerFieldRenderer('number', ModifierNumberRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('slider', ModifierSliderRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('select', ModifierSelectRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('color', ModifierColorRenderer as FieldRenderer<FieldDef>);
}
