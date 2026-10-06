import {
  type FieldDef,
  type FieldRenderer,
  FieldShell,
  type PanelView,
  ReadOnlyText,
  registerFieldRenderer,
} from '@preset.nz/facets';
import { Star, TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type FontFamilyGroup, useFontCatalogueStore } from '@/fonts/catalogue';
import { buildPickerSections } from '@/fonts/pickerSections';
import {
  noteUsed,
  toggleFavourite,
  useFavouritesOnlyStore,
  useFontPreferencesStore,
} from '@/fonts/preferences';
import { cn } from '@/lib/utils';
import { beginTransaction, endTransaction } from '@/scene/history';
import { beginTextEdit, commitActiveTextEdit, useTextEditStore } from '@/scene/textEditState';
import type { OptionalColourFieldDef, TextScopeContext } from './textScope';

/**
 * Custom facets field kinds for the Text inspector (text-tool-and-inspector.md).
 * facets doesn't type-check a custom kind's extra props, so they're documented
 * here: `font-family`/`font-style` read the node's `FontRef` from the panel's
 * `ctx` (`TextScopeContext`); `optional-colour` reads `fallback`; `text-content`
 * is the words themselves (dogfood-revisions.md) and reads `ctx.nodeId`.
 */

/** Current value as plain text — the catalogue-not-ready / read-only presentation. */
function ReadOnlyValue({ label, text, view }: { label: string; text: string; view?: PanelView }) {
  return (
    <FieldShell label={label} view={view}>
      <ReadOnlyText>
        <span className="block truncate" title={text}>
          {text || '—'}
        </span>
      </ReadOnlyText>
    </FieldShell>
  );
}

/** Amber marker for a font that isn't installed; `hint` is the tooltip (missing-fonts.md). */
function MissingMarker({ hint }: { hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <TriangleAlert
            size={12}
            className="shrink-0 text-amber-400"
            role="img"
            aria-label={hint}
          />
        }
      />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/** One picker row: the family button, and a star that toggles the favourite without picking. */
function PickerRow({
  group,
  selected,
  starred,
  onPick,
}: {
  group: FontFamilyGroup;
  selected: boolean;
  starred: boolean;
  onPick: (family: string) => void;
}) {
  return (
    <div
      className={cn(
        'group flex items-center rounded hover:bg-neutral-800',
        selected && 'bg-neutral-800',
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className={cn(
          'min-w-0 flex-1 truncate px-2 py-1 text-left text-xs',
          selected && 'text-neutral-50',
        )}
        onClick={() => onPick(group.family)}
      >
        {group.family}
      </button>
      <button
        type="button"
        aria-label={starred ? `Unfavourite ${group.family}` : `Favourite ${group.family}`}
        aria-pressed={starred}
        className={cn(
          'mr-1 shrink-0 rounded p-1',
          starred ? 'text-amber-400' : 'text-neutral-600 hover:text-neutral-300',
        )}
        onClick={(e) => {
          // Starring must not pick the family.
          e.stopPropagation();
          void toggleFavourite(group.family);
        }}
      >
        <Star size={12} fill={starred ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}

/** Also used outside facets by the Replace Font dialog. `missingHint` adds the amber marker. */
export function FontFamilyField({
  label,
  family,
  onChange,
  disabled,
  missingHint,
  view,
}: {
  label: string;
  family: string;
  onChange?: (next: string) => void;
  disabled: boolean;
  missingHint?: string;
  view?: PanelView;
}) {
  const status = useFontCatalogueStore((s) => s.status);
  const pickerFamilies = useFontCatalogueStore((s) => s.pickerFamilies);
  const prefs = useFontPreferencesStore((s) => s.prefs);
  const favouritesOnly = useFavouritesOnlyStore((s) => s.on);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const sections = useMemo(
    () => buildPickerSections(pickerFamilies, prefs, query, favouritesOnly),
    [pickerFamilies, prefs, query, favouritesOnly],
  );

  if (status !== 'ready' || !onChange || disabled) {
    return (
      <div className="flex items-end gap-1">
        <div className="min-w-0 flex-1">
          <ReadOnlyValue label={label} text={family} view={view} />
        </div>
        {missingHint && <MissingMarker hint={missingHint} />}
      </div>
    );
  }

  const starred = new Set(prefs.favourites.map((f) => f.toLowerCase()));
  const pick = (name: string) => {
    onChange(name);
    void noteUsed(name);
    setOpen(false);
  };

  return (
    <FieldShell label={label} view={view}>
      <div className="flex items-center gap-1">
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery('');
          }}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={label}
                className="min-w-0 flex-1 truncate rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-left text-xs hover:bg-neutral-800"
              />
            }
          >
            {family}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            <div className="mb-1 flex items-center gap-1">
              <input
                type="text"
                aria-label="Search fonts"
                placeholder="Search fonts"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1 text-xs outline-none ring-1 ring-neutral-700 focus:ring-sky-500"
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Favourites only"
                      aria-pressed={favouritesOnly}
                      onClick={() => useFavouritesOnlyStore.getState().setOn(!favouritesOnly)}
                      className={cn(
                        'shrink-0 rounded p-1.5 hover:bg-neutral-800',
                        favouritesOnly ? 'text-amber-400' : 'text-neutral-500',
                      )}
                    />
                  }
                >
                  <Star size={14} fill={favouritesOnly ? 'currentColor' : 'none'} />
                </TooltipTrigger>
                <TooltipContent>Favourites only</TooltipContent>
              </Tooltip>
            </div>
            <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Font families">
              {sections.length === 0 && (
                <div className="px-2 py-1 text-xs text-neutral-500">
                  {favouritesOnly && !query.trim() ? 'No favourites yet.' : 'No matching fonts.'}
                </div>
              )}
              {sections.map((section) => (
                <div key={section.id}>
                  {section.heading && (
                    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
                      {section.heading}
                    </div>
                  )}
                  {section.families.map((f) => (
                    <PickerRow
                      key={f.family}
                      group={f}
                      selected={f.family === family}
                      starred={starred.has(f.family.toLowerCase())}
                      onPick={pick}
                    />
                  ))}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        {missingHint && <MissingMarker hint={missingHint} />}
      </div>
    </FieldShell>
  );
}

const FontFamilyRenderer: FieldRenderer<FieldDef> = ({
  field,
  value,
  disabled,
  onChange,
  ctx,
  view,
}) => (
  <FontFamilyField
    view={view}
    label={field.label ?? field.id}
    family={typeof value === 'string' ? value : ''}
    disabled={disabled}
    onChange={onChange ? (next) => onChange(next) : undefined}
    missingHint={(ctx as TextScopeContext | null)?.missingHint}
  />
);

/** Also used outside facets by the Replace Font dialog. */
export function FontStyleField({
  label,
  font,
  onChange,
  disabled,
  view,
}: {
  label: string;
  font: TextScopeContext['font'];
  onChange?: (next: string) => void;
  disabled: boolean;
  view?: PanelView;
}) {
  const status = useFontCatalogueStore((s) => s.status);
  const families = useFontCatalogueStore((s) => s.families);
  const faces = families.find((f) => f.family.toLowerCase() === font.family.toLowerCase())?.faces;

  // Not ready, read-only, or the family isn't installed (a missing font): show
  // the wanted style as text rather than an empty select.
  if (status !== 'ready' || !onChange || disabled || !faces || faces.length === 0) {
    return <ReadOnlyValue label={label} text={font.style} view={view} />;
  }

  // A select item's value is the face's PostScript name: a style name isn't
  // guaranteed unique within a family. The scope's `font.style` write takes it.
  const current = faces.some((f) => f.postscriptName === font.postscriptName)
    ? font.postscriptName
    : undefined;
  const items = faces.map((f) => ({
    value: f.postscriptName,
    // A face with no decodable style name still needs a visible label.
    label: f.style || f.postscriptName,
  }));
  return (
    <FieldShell label={label} view={view}>
      <Select
        value={current ?? null}
        items={items}
        onValueChange={(next) => {
          if (next != null) onChange(next);
        }}
      >
        <SelectTrigger size="sm" className="w-full text-xs" aria-label={label}>
          <SelectValue placeholder={font.style} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="text-xs">
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

const FontStyleRenderer: FieldRenderer<FieldDef> = ({
  field,
  value,
  disabled,
  onChange,
  ctx,
  view,
}) => {
  const font = (ctx as TextScopeContext | null)?.font;
  if (!font) {
    return <ReadOnlyValue label={field.label ?? field.id} text={String(value ?? '')} view={view} />;
  }
  return (
    <FontStyleField
      view={view}
      label={field.label ?? field.id}
      font={font}
      disabled={disabled}
      onChange={onChange ? (next) => onChange(next) : undefined}
    />
  );
};

const TEXT_MIN_ROWS = 2;
const TEXT_MAX_ROWS = 8;

/** How long a pointer-initiated focus is defended if no pointerup arrives to end it (ms). */
const FOCUS_SETTLE_MAX_MS = 1000;

/**
 * The Text inspector's words field (dogfood-revisions.md): a multi-line
 * `<textarea>` that autosizes from 2 to 8 rows. **Its focus is the edit
 * transaction**: focus calls `beginTextEdit`, blur calls
 * `commitActiveTextEdit` (new blank node removed with no history entry,
 * otherwise one undo step). Every input writes the content straight through, so
 * the canvas shows the type live while the field, off to the side, holds the caret.
 *
 * The canvas asks for focus through the shared edit store's `focusTarget`
 * (T-click, double-click, Enter), which this field consumes on mount or when
 * the request counter bumps.
 */
function TextContentField({
  label,
  nodeId,
  value,
  readOnly,
  onChange,
  view,
}: {
  label: string;
  nodeId: string;
  value: string;
  readOnly: boolean;
  onChange?: (next: string) => void;
  view?: PanelView;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // True from a pointer-initiated focus request until that pointer is released:
  // the pointerdown that asked for focus can still pull it away afterwards
  // (default action of the press), which must not read as "the user left".
  const settling = useRef(false);
  const stopSettling = useRef<(() => void) | null>(null);
  const focusRequest = useTextEditStore((s) => s.focusRequest);
  const focusTarget = useTextEditStore((s) => s.focusTarget);

  // Autosize 2..8 rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger, not an input of the measurement
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lineHeight = Number.parseFloat(cs.lineHeight) || 16;
    const px = (v: string) => Number.parseFloat(v) || 0;
    const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const chrome = border + px(cs.paddingTop) + px(cs.paddingBottom);
    const min = lineHeight * TEXT_MIN_ROWS + chrome;
    const max = lineHeight * TEXT_MAX_ROWS + chrome;
    el.style.height = 'auto';
    const wanted = el.scrollHeight + border;
    el.style.height = `${Math.min(max, Math.max(min, wanted))}px`;
    el.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }, [value]);

  // Honour a focus ask for this node (on mount too: the section may have been
  // collapsed or on another tab when it was made).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `focusRequest` re-fires an ask for the same node
  useEffect(() => {
    if (!focusTarget || focusTarget.nodeId !== nodeId) return;
    const consume = useTextEditStore.getState().consumeFocusRequest;
    const el = ref.current;
    if (!el || readOnly) {
      consume();
      return;
    }
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    consume();
    if (!focusTarget.viaPointer) return;

    stopSettling.current?.();
    settling.current = true;
    const end = () => {
      settling.current = false;
      stopSettling.current = null;
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.clearTimeout(timer);
    };
    // Stop defending once the press's own default action has run.
    const onUp = () => requestAnimationFrame(() => requestAnimationFrame(end));
    const timer = window.setTimeout(end, FOCUS_SETTLE_MAX_MS);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    stopSettling.current = end;
    // Re-assert once, after the press's default action has had its turn.
    requestAnimationFrame(() => {
      if (el.isConnected && document.activeElement !== el) el.focus();
    });
  }, [focusRequest, focusTarget, nodeId, readOnly]);

  // Drop the settle listeners if the field unmounts mid-press.
  useEffect(() => () => stopSettling.current?.(), []);

  // A primary press anywhere else ends the edit. Blur alone isn't enough: a
  // pointerdown the canvas cancels (preventDefault) may leave focus where it was.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (!el || e.button !== 0 || settling.current || document.activeElement !== el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.blur();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  return (
    <FieldShell label={label} view={view} top>
      <textarea
        ref={ref}
        aria-label={label}
        value={value}
        rows={TEXT_MIN_ROWS}
        readOnly={readOnly}
        spellCheck={false}
        onFocus={() => {
          if (!readOnly) beginTextEdit(nodeId, false);
        }}
        onBlur={() => {
          const el = ref.current;
          if (settling.current && el) {
            // Focus was pulled away by the very press that asked for it: take it back, don't commit.
            requestAnimationFrame(() => el.focus());
            return;
          }
          commitActiveTextEdit();
        }}
        onChange={(e) => {
          if (!onChange) return;
          // Cmd+Z mid-typing commits first (menu.ts) and leaves the caret here:
          // typing on opens a fresh edit rather than writing outside any transaction.
          if (useTextEditStore.getState().editing?.nodeId !== nodeId) beginTextEdit(nodeId, false);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // IME owns Enter/Escape mid-composition
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
          }
          // Plain Enter is a newline (point text, manual line breaks only).
        }}
        className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none focus:border-sky-400 read-only:opacity-60"
      />
    </FieldShell>
  );
}

const TextContentRenderer: FieldRenderer<FieldDef> = ({ field, value, onChange, ctx, view }) => {
  const nodeId = (ctx as TextScopeContext | null)?.nodeId;
  if (!nodeId) return null;
  return (
    <TextContentField
      view={view}
      label={field.label ?? field.id}
      nodeId={nodeId}
      value={typeof value === 'string' ? value : ''}
      readOnly={!onChange}
      onChange={onChange ? (next) => onChange(next) : undefined}
    />
  );
};

function OptionalColour({
  field,
  value,
  disabled,
  onChange,
  view,
}: {
  field: OptionalColourFieldDef;
  value: unknown;
  disabled: boolean;
  view?: PanelView;
  /** A colour recolours, `null` disables, `true` enables (the scope restores the remembered colour). */
  onChange?: (next: string | true | null) => void;
}) {
  const colour = typeof value === 'string' && value.length > 0 ? value : null;
  // The swatch keeps showing the last colour seen while disabled (or the fallback);
  // the scope owns the restore on re-enable.
  const lastRef = useRef(colour ?? field.fallback);
  if (colour) lastRef.current = colour;
  const readOnly = disabled || !onChange;
  const label = field.label ?? field.id;
  const swatch = colour ?? lastRef.current;
  const checkId = `optional-colour-enabled-${field.id}`;

  return (
    <FieldShell label={label} view={view}>
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
            checked={colour !== null}
            disabled={readOnly}
            onCheckedChange={(checked) => onChange?.(checked === true ? true : null)}
          />
          Enabled
        </label>
      </div>
    </FieldShell>
  );
}

const OptionalColourRenderer: FieldRenderer<FieldDef> = ({
  field,
  value,
  disabled,
  onChange,
  view,
}) => (
  <OptionalColour
    view={view}
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
  registerFieldRenderer('text-content', TextContentRenderer);
}
