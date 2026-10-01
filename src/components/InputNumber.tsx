import * as React from 'react';

import { applyDelta, applyKeyStep, parseCommit, roundToStep } from '@/components/inputNumberMath';
import { LabelTip } from '@/components/LabelTip';
import { cn } from '@/lib/utils';

/** Pixels of horizontal movement before a label pointerdown counts as a scrub-drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

export interface InputNumberProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** @default 1 */
  step?: number;
  label: string;
  /** Optional hover text for the label (a tooltip after a short delay). */
  description?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Soft-max dogfood fix (Epic 04 stack-rows): when `true`, a typed commit
   * (Enter/blur) is allowed to exceed `max` — scrub-drag and keyboard
   * arrows still clamp to `[min, max]` per spec. Op param ranges are
   * conservative guesses; typed entry is the Blender-style escape hatch.
   * @default false
   */
  allowTypedOverMax?: boolean;
  /**
   * Fired once a label pointerdown crosses the scrub-drag threshold (before
   * the first `onChange` of the drag), and once when the drag ends —
   * `InputNumber`'s drag lifecycle is the transaction-boundary hook for
   * undo/history (Epic 13): callers wrap these around a single coalesced
   * undo step. Optional and unused by callers that don't care (kept generic
   * — no history-module import in this file).
   */
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startValue: number;
  dragging: boolean;
}

function formatValue(value: number, step: number): string {
  return roundToStep(value, step).toString();
}

/**
 * The keystone parameter control: scrub-drag on the label (pointer capture,
 * horizontal drag, Shift = x10, Alt = x0.1), click-to-type, keyboard arrows,
 * min/max clamp. Fires `onChange` continuously while scrubbing.
 */
export function InputNumber({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  description,
  disabled = false,
  className,
  allowTypedOverMax = false,
  onDragStart,
  onDragEnd,
}: InputNumberProps) {
  const [editing, setEditing] = React.useState(false);
  const [editText, setEditText] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dragStateRef = React.useRef<DragState | null>(null);
  const isEditingRef = React.useRef(false);

  const setEditingBoth = React.useCallback((next: boolean) => {
    isEditingRef.current = next;
    setEditing(next);
  }, []);

  const beginEditing = React.useCallback(() => {
    if (disabled) return;
    setEditText(formatValue(value, step));
    setEditingBoth(true);
  }, [disabled, value, step, setEditingBoth]);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = React.useCallback(() => {
    const next = parseCommit(editText, value, step, min, max, !allowTypedOverMax);
    setEditingBoth(false);
    if (next !== value) onChange(next);
  }, [editText, value, step, min, max, allowTypedOverMax, onChange, setEditingBoth]);

  const revert = React.useCallback(() => {
    setEditingBoth(false);
  }, [setEditingBoth]);

  function handleLabelPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    if (disabled) return;
    // Dogfood fix: a label scrub-drag must never fall through to the
    // browser's native text-selection gesture (dragging over sibling
    // labels/panels would otherwise highlight text instead of scrubbing).
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startValue: value,
      dragging: false,
    };
  }

  function handleLabelPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const state = dragStateRef.current;
    if (!state || disabled || state.pointerId !== e.pointerId) return;
    if (e.cancelable) e.preventDefault();
    const dx = e.clientX - state.startX;
    if (!state.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      state.dragging = true;
      onDragStart?.();
    }
    const mods = { shift: e.shiftKey, alt: e.altKey };
    const next = applyDelta(state.startValue, dx, step, mods, min, max);
    if (next !== value) onChange(next);
  }

  function handleLabelPointerUp(e: React.PointerEvent<HTMLSpanElement>) {
    const state = dragStateRef.current;
    if (
      state &&
      state.pointerId === e.pointerId &&
      e.currentTarget.hasPointerCapture(e.pointerId)
    ) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const wasDragging = state?.dragging ?? false;
    dragStateRef.current = null;
    if (wasDragging) {
      onDragEnd?.();
    } else if (!disabled) {
      beginEditing();
    }
  }

  function handleLabelPointerCancel(e: React.PointerEvent<HTMLSpanElement>) {
    const state = dragStateRef.current;
    if (state && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const wasDragging = state?.dragging ?? false;
    dragStateRef.current = null;
    if (wasDragging) onDragEnd?.();
  }

  function handleInputFocus() {
    if (!isEditingRef.current) beginEditing();
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setEditText(e.target.value);
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      revert();
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const mods = { shift: e.shiftKey, alt: e.altKey };
      const direction = e.key === 'ArrowUp' ? 1 : -1;
      const next = applyKeyStep(value, direction, step, mods, min, max);
      if (next !== value) onChange(next);
      setEditText(formatValue(next, step));
    }
  }

  function handleInputBlur() {
    if (isEditingRef.current) commit();
  }

  return (
    <div className={cn('flex items-center gap-2 text-sm', className)}>
      <LabelTip description={description}>
        <span
          className={cn(
            'select-none whitespace-nowrap text-foreground/60',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-ew-resize hover:text-foreground',
          )}
          onPointerDown={handleLabelPointerDown}
          onPointerMove={handleLabelPointerMove}
          onPointerUp={handleLabelPointerUp}
          onPointerCancel={handleLabelPointerCancel}
        >
          {label}
        </span>
      </LabelTip>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={editing ? editText : formatValue(value, step)}
        onFocus={handleInputFocus}
        onChange={handleInputChange}
        onKeyDown={handleInputKeyDown}
        onBlur={handleInputBlur}
        className={cn(
          'w-16 rounded-md border border-input bg-input/30 px-1.5 py-0.5 text-right text-foreground shadow-xs outline-none transition-[color,box-shadow]',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      />
    </div>
  );
}
