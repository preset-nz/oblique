import { type RefObject, useEffect, useRef } from 'react';
import { panBy, useViewTransformStore, zoomAt } from './viewTransform';

const ZOOM_WHEEL_SENSITIVITY = 0.0015;

interface PointerState {
  pointerId: number;
  lastX: number;
  lastY: number;
}

/**
 * Pan/zoom gesture logic for the viewport.
 *
 * Pan: space-held drag (any button) or middle-button drag.
 * Zoom: wheel, cursor-centred.
 *
 * Pointer Events API only — no mouse/touch handlers. Wheel is not a
 * mouse-event and is exempt from that rule (the story calls it out
 * explicitly as the zoom input).
 */
export function usePanZoom(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const spaceHeldRef = useRef(false);
  const panRef = useRef<PointerState | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        spaceHeldRef.current = true;
        e.preventDefault();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const isMiddleButton = e.button === 1;
      const isSpacePan = spaceHeldRef.current && e.button === 0;
      if (!isMiddleButton && !isSpacePan) return;

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      panRef.current = {
        pointerId: e.pointerId,
        lastX: e.clientX - rect.left,
        lastY: e.clientY - rect.top,
      };
    };

    const handlePointerMove = (e: PointerEvent) => {
      const pan = panRef.current;
      if (!pan || pan.pointerId !== e.pointerId) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dx = x - pan.lastX;
      const dy = y - pan.lastY;
      pan.lastX = x;
      pan.lastY = y;

      const { view, setView } = useViewTransformStore.getState();
      setView(panBy(view, dx, dy));
    };

    const endPan = (e: PointerEvent) => {
      const pan = panRef.current;
      if (!pan || pan.pointerId !== e.pointerId) return;
      canvas.releasePointerCapture(e.pointerId);
      panRef.current = null;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // deltaMode 0 = pixels (trackpads, most mice); 1 = lines (some mice);
      // 2 = pages. Normalise so line/page-mode devices don't feel stuck.
      const deltaUnit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const factor = Math.exp(-e.deltaY * deltaUnit * ZOOM_WHEEL_SENSITIVITY);

      const { view, setView } = useViewTransformStore.getState();
      setView(zoomAt(view, cursor, factor));
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);
    // Must be a non-passive listener so we can preventDefault the page/OS zoom.
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', endPan);
      canvas.removeEventListener('pointercancel', endPan);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [canvasRef]);
}
