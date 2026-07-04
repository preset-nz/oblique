import {
  type FieldDef,
  type FieldRenderer,
  registerFieldRenderer,
  type SelectFieldDef,
} from '@preset.nz/property-editors';
import { InputNumber } from '@/components/InputNumber';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { snapToIntegerStep } from './integerStepFix';
import type { ModifierNumberFieldDef, ModifierSliderFieldDef } from './modifierScope';

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
  return (
    <InputNumber
      label={field.label ?? field.id}
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
    />
  );
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
      <span className="text-[11px] font-medium text-muted-foreground tracking-wide">
        {field.label ?? field.id}
      </span>
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
          className="flex-1"
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
const ModifierSelectRenderer: FieldRenderer<SelectFieldDef> = ({
  field,
  value,
  disabled,
  onChange,
}) => {
  const options = field.options ?? [];
  const current = value == null ? '' : String(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground tracking-wide">
        {field.label ?? field.id}
      </span>
      <ToggleGroup
        type="single"
        size="sm"
        spacing={0}
        value={current}
        disabled={disabled || !onChange}
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
 * Registers Oblique's `number`/`slider`/`select` renderers, overriding the
 * shared package's plain-`<input>`/`<select>` builtins with the scrub-drag
 * `InputNumber` and the `ToggleGroup` segmented control. Call once at app
 * start, after `registerBuiltinRenderers()`.
 */
export function registerModifierFieldRenderers(): void {
  registerFieldRenderer('number', ModifierNumberRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('slider', ModifierSliderRenderer as FieldRenderer<FieldDef>);
  registerFieldRenderer('select', ModifierSelectRenderer as FieldRenderer<FieldDef>);
}
