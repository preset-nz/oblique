import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { insertionIndexFor, insertionLineY, moveTarget, type RowRect } from './dragReorder';

/** Rows opt in with this attribute (value = the row's display index). */
export const REORDER_INDEX_ATTR = 'data-reorder-index';

/** Pointer travel (px) before a press on the grip becomes a drag, so a plain click is not one. */
const DRAG_THRESHOLD_PX = 3;

interface DragSession {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  active: boolean;
  insertion: number;
  /** Row rects (viewport space), measured once at pointerdown, sorted by display index. */
  rects: RowRect[];
  /** Container's viewport top at pointerdown — converts rect space to container space. */
  containerTop: number;
  target: HTMLElement;
}

interface UseDragReorderOptions {
  /** The positioned (`relative`) element that holds the rows and the indicator overlay. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Called once on drop with the dragged row's display index and the
   * `toIndex` a remove-then-insert reorder expects (see `moveTarget`). Never
   * called for a no-op drop, a cancel, or a click.
   */
  onCommit: (from: number, to: number) => void;
}

/**
 * Shared Pointer-Events drag-to-reorder for the layer list and the modifier
 * stack (drag-reorder.md). The drag starts only from the grip — spread
 * `gripProps(index)` onto it — so clicks on the rest of the row and the
 * controls inside it are untouched. No live re-layout: the list reflows once,
 * on drop, via `onCommit`.
 */
export function useDragReorder({ containerRef, onCommit }: UseDragReorderOptions) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const stopEscapeRef = useRef<(() => void) | null>(null);

  function reset() {
    const session = sessionRef.current;
    sessionRef.current = null;
    stopEscapeRef.current?.();
    stopEscapeRef.current = null;
    if (session?.target.hasPointerCapture(session.pointerId)) {
      session.target.releasePointerCapture(session.pointerId);
    }
    setDraggingIndex(null);
    setInsertionIndex(null);
    setIndicatorTop(null);
  }

  // Leaving mid-drag (row unmounted, panel closed) must not leak the window listener.
  useEffect(
    () => () => {
      stopEscapeRef.current?.();
    },
    [],
  );

  function measureRows(): { rects: RowRect[]; containerTop: number } | null {
    const container = containerRef.current;
    if (!container) return null;
    const rows = Array.from(container.querySelectorAll<HTMLElement>(`[${REORDER_INDEX_ATTR}]`));
    rows.sort(
      (a, b) =>
        Number(a.getAttribute(REORDER_INDEX_ATTR)) - Number(b.getAttribute(REORDER_INDEX_ATTR)),
    );
    const rects = rows.map((row) => {
      const r = row.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    return { rects, containerTop: container.getBoundingClientRect().top };
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, index: number) {
    if (e.button !== 0 || sessionRef.current) return;
    const measured = measureRows(); // once per press — no layout reads while moving
    if (!measured) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    sessionRef.current = {
      pointerId: e.pointerId,
      from: index,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      insertion: index,
      ...measured,
      target: e.currentTarget,
    };
    // Escape is a held-gesture cancel, not a command, and a WKWebView button
    // doesn't take focus on press — so a grip-level onKeyDown alone would
    // miss it. Listen on the window for the life of the drag only, in capture
    // so the canvas's Escape-to-deselect never sees it.
    const onWindowKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      ev.preventDefault();
      reset();
    };
    window.addEventListener('keydown', onWindowKeyDown, true);
    stopEscapeRef.current = () => window.removeEventListener('keydown', onWindowKeyDown, true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    if (!session.active) {
      if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD_PX) {
        return;
      }
      session.active = true;
      setDraggingIndex(session.from);
    }
    const insertion = insertionIndexFor(e.clientY, session.rects);
    session.insertion = insertion;
    setInsertionIndex(insertion);
    // No indicator over the row's own slot: dropping there does nothing.
    const y =
      moveTarget(session.from, insertion) === null
        ? null
        : insertionLineY(insertion, session.rects);
    setIndicatorTop(y === null ? null : y - session.containerTop);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLElement>) {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    const to = session.active ? moveTarget(session.from, session.insertion) : null;
    const from = session.from;
    reset();
    if (to !== null) onCommitRef.current(from, to);
  }

  function onPointerCancel(e: ReactPointerEvent<HTMLElement>) {
    if (sessionRef.current && e.pointerId === sessionRef.current.pointerId) reset();
  }

  function gripProps(index: number) {
    return {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onPointerDown(e, index),
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
        if (e.key === 'Escape' && sessionRef.current) {
          e.stopPropagation();
          reset();
        }
      },
      // A drop ends in a click on the grip; it must not bubble to the row and change selection.
      onClick: (e: ReactMouseEvent<HTMLElement>) => e.stopPropagation(),
      style: { touchAction: 'none' as const },
    };
  }

  return { draggingIndex, insertionIndex, indicatorTop, gripProps };
}
