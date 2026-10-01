import { type FieldDef, type FieldRenderer, registerFieldRenderer } from '@preset.nz/facets';
import { useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { cn } from '@/lib/utils';
import { beginTransaction, endTransaction } from '@/scene/history';
import type { OptionalColourFieldDef, TextScopeContext } from './textScope';

/**
 * Custom facets field kinds for the Text inspector (text-tool-and-inspector.md).
 * facets doesn't type-check a custom kind's extra props, so they're documented
 * here: `font-family`/`font-style` read the node's `FontRef` from the panel's
 * `ctx` (`TextScopeContext`); `optional-colour` reads `fallback`.
 */

const labelClass = 'text-[11px] font-medium text-muted-foreground tracking-wide';

function FieldLabel({ text, dim }: { text: string; dim?: boolean }) {
  return <span className={cn(labelClass, dim && 'opacity-50')}>{text}</span>;
}

/** Current value as plain text — the catalogue-not-ready / read-only presentation. */
function ReadOnlyText({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel text={label} />
      <span className="truncate text-xs text-neutral-300" title={text}>
        {text || '—'}
      </span>
    </div>
  );
}

function FontFamilyField({
  label,
  family,
  onChange,
  disabled,
}: {
  label: string;
  family: string;
  onChange?: (next: string) => void;
  disabled: boolean;
}) {
  const status = useFontCatalogueStore((s) => s.status);
  const families = useFontCatalogueStore((s) => s.families);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  if (status !== 'ready' || !onChange || disabled) {
    return <ReadOnlyText label={label} text={family} />;
  }

  const needle = query.trim().toLowerCase();
  const shown = needle ? families.filter((f) => f.family.toLowerCase().includes(needle)) : families;

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel text={label} />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="truncate rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-left text-xs hover:bg-neutral-800"
          >
            {family}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <input
            type="text"
            aria-label="Search fonts"
            placeholder="Search fonts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-1 w-full rounded bg-neutral-900 px-2 py-1 text-xs outline-none ring-1 ring-neutral-700 focus:ring-sky-500"
          />
          <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Font families">
            {shown.length === 0 && (
              <div className="px-2 py-1 text-xs text-neutral-500">No matching fonts.</div>
            )}
            {shown.map((f) => (
              <button
                key={f.family}
                type="button"
                role="option"
                aria-selected={f.family === family}
                className={cn(
                  'block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-neutral-800',
                  f.family === family && 'bg-neutral-800 text-neutral-50',
                )}
                onClick={() => {
                  onChange(f.family);
                  setOpen(false);
                }}
              >
                {f.family}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const FontFamilyRenderer: FieldRenderer<FieldDef> = ({ field, value, disabled, onChange }) => (
  <FontFamilyField
    label={field.label ?? field.id}
    family={typeof value === 'string' ? value : ''}
    disabled={disabled}
    onChange={onChange ? (next) => onChange(next) : undefined}
  />
);

function FontStyleField({
  label,
  font,
  onChange,
  disabled,
}: {
  label: string;
  font: TextScopeContext['font'];
  onChange?: (next: string) => void;
  disabled: boolean;
}) {
  const status = useFontCatalogueStore((s) => s.status);
  const families = useFontCatalogueStore((s) => s.families);
  const faces = families.find((f) => f.family.toLowerCase() === font.family.toLowerCase())?.faces;

  // Not ready, read-only, or the family isn't installed (a missing font): show
  // the wanted style as text rather than an empty select.
  if (status !== 'ready' || !onChange || disabled || !faces || faces.length === 0) {
    return <ReadOnlyText label={label} text={font.style} />;
  }

  // A select item's value is the face's PostScript name: a style name isn't
  // guaranteed unique within a family. The scope's `font.style` write takes it.
  const current = faces.some((f) => f.postscriptName === font.postscriptName)
    ? font.postscriptName
    : undefined;
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel text={label} />
      <Select value={current} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-full text-xs" aria-label={label}>
          <SelectValue placeholder={font.style} />
        </SelectTrigger>
        <SelectContent>
          {faces.map((f) => (
            <SelectItem key={f.postscriptName} value={f.postscriptName} className="text-xs">
              {f.style}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const FontStyleRenderer: FieldRenderer<FieldDef> = ({ field, value, disabled, onChange, ctx }) => {
  const font = (ctx as TextScopeContext | null)?.font;
  if (!font) return <ReadOnlyText label={field.label ?? field.id} text={String(value ?? '')} />;
  return (
    <FontStyleField
      label={field.label ?? field.id}
      font={font}
      disabled={disabled}
      onChange={onChange ? (next) => onChange(next) : undefined}
    />
  );
};

function OptionalColour({
  field,
  value,
  disabled,
  onChange,
}: {
  field: OptionalColourFieldDef;
  value: unknown;
  disabled: boolean;
  onChange?: (next: string | null) => void;
}) {
  const colour = typeof value === 'string' && value.length > 0 ? value : null;
  // "None" -> unchecked restores the last colour seen (or the field's fallback).
  const lastRef = useRef(colour ?? field.fallback);
  if (colour) lastRef.current = colour;
  const readOnly = disabled || !onChange;
  const label = field.label ?? field.id;
  const swatch = colour ?? lastRef.current;
  const checkId = `optional-colour-none-${field.id}`;

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel text={label} dim={readOnly} />
      <div className={cn('flex items-center gap-2', readOnly && 'opacity-50')}>
        <input
          type="color"
          aria-label={label}
          value={swatch}
          disabled={readOnly || colour === null}
          onChange={(e) => onChange?.(e.target.value)}
          // One picker session = one undo step (same boundary as the
          // modifier colour renderer: focus/blur around the OS picker).
          onFocus={() => beginTransaction()}
          onBlur={() => endTransaction()}
          className={cn(
            'h-6 w-8 cursor-pointer rounded border border-neutral-700 bg-transparent disabled:cursor-not-allowed',
            colour === null && 'opacity-40',
          )}
        />
        <span className="font-mono text-xs text-muted-foreground">{colour ?? '—'}</span>
        <label htmlFor={checkId} className="ml-auto flex items-center gap-1.5 text-xs">
          <Checkbox
            id={checkId}
            className="border-neutral-500"
            checked={colour === null}
            disabled={readOnly}
            onCheckedChange={(checked) => onChange?.(checked === true ? null : lastRef.current)}
          />
          None
        </label>
      </div>
    </div>
  );
}

const OptionalColourRenderer: FieldRenderer<FieldDef> = ({ field, value, disabled, onChange }) => (
  <OptionalColour
    field={field as unknown as OptionalColourFieldDef}
    value={value}
    disabled={disabled}
    onChange={onChange ? (next) => onChange(next) : undefined}
  />
);

/** Registers the Text inspector's custom kinds. Idempotent. */
export function registerTextFieldRenderers(): void {
  registerFieldRenderer('font-family', FontFamilyRenderer);
  registerFieldRenderer('font-style', FontStyleRenderer);
  registerFieldRenderer('optional-colour', OptionalColourRenderer);
}
