import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useRef } from 'react';
import { importFiles, tauriImportDeps } from '@/project/import';
import { usePanZoom } from './usePanZoom';
import { screenToDoc, useViewTransformStore } from './viewTransform';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// Placeholder calibration fixtures (Epic 02 replaces these with the real
// scene/document + compositor output).
const DOC_SIZE = 1024;
const SQUARE_SIZE = 64;
const CHECKER_LIGHT = '#3a3a3a';
const CHECKER_DARK = '#2a2a2a';
const MARKER_DOC_POINT = { x: 100, y: 100 };

function drawCheckerboard(ctx: CanvasRenderingContext2D) {
  const squares = DOC_SIZE / SQUARE_SIZE;
  for (let row = 0; row < squares; row++) {
    for (let col = 0; col < squares; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
      ctx.fillRect(col * SQUARE_SIZE, row * SQUARE_SIZE, SQUARE_SIZE, SQUARE_SIZE);
    }
  }
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dprRef = useRef(1);
  // Selecting `view` re-renders this component on every pan/zoom tick so the
  // SVG overlay's transform attribute stays in lockstep with the canvas
  // paint. That's one cheap attribute update per frame, not a full repaint.
  const view = useViewTransformStore((state) => state.view);

  usePanZoom(canvasRef);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = dprRef.current;
    const { view: currentView } = useViewTransformStore.getState();

    // Reset to identity for the clear, then apply document->device transform.
    // devicePixelRatio scales only the backing store (this transform); it
    // never enters the stored view or the SVG overlay's matrix.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(
      currentView.scale * dpr,
      0,
      0,
      currentView.scale * dpr,
      currentView.tx * dpr,
      currentView.ty * dpr,
    );
    ctx.imageSmoothingEnabled = false;
    drawCheckerboard(ctx);
  }, []);

  // Resize observer: keeps the canvas backing store matched to the
  // container's CSS size * devicePixelRatio, and fits the view the first
  // time we learn a non-zero viewport size.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let hasFitted = false;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;

      const cssW = Math.max(1, Math.round(rect.width));
      const cssH = Math.max(1, Math.round(rect.height));

      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);

      const store = useViewTransformStore.getState();
      store.setViewportSize(cssW, cssH);
      if (!hasFitted && cssW > 0 && cssH > 0) {
        hasFitted = true;
        store.fitToWindow();
      }
      paint();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [paint]);

  // Coalesce store-driven repaints (pan/zoom) into one rAF per frame.
  useEffect(() => {
    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        paint();
      });
    };
    // Only view changes repaint; cursorDoc updates every pointermove and
    // must not reach the canvas paint path.
    const unsubscribe = useViewTransformStore.subscribe((state, prev) => {
      if (state.view !== prev.view) schedule();
    });
    return () => {
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [paint]);

  const overlayMatrix = `matrix(${view.scale} 0 0 ${view.scale} ${view.tx} ${view.ty})`;
  const markerRadius = 6 / view.scale;
  const markerStroke = 2 / view.scale;

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    const { view: currentView } = useViewTransformStore.getState();
    const docPt = screenToDoc(currentView, { x: screenX, y: screenY });
    useViewTransformStore.getState().setCursorDoc(docPt);
  }, []);

  const handlePointerLeave = useCallback(() => {
    useViewTransformStore.getState().setCursorDoc(null);
  }, []);

  // Drop target: real Tauri drag-drop event, NOT the HTML5 drop API — the
  // webview's HTML5 drop handler never carries real filesystem paths (see
  // pixel-node-import.md §Flow).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        const paths = event.payload.paths.filter(isImagePath);
        if (paths.length === 0) return;
        void importFiles(paths, tauriImportDeps);
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-neutral-900"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} className="absolute inset-0 touch-none" />
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        role="presentation"
        aria-hidden="true"
      >
        <g transform={overlayMatrix}>
          <circle
            cx={MARKER_DOC_POINT.x}
            cy={MARKER_DOC_POINT.y}
            r={markerRadius}
            fill="none"
            stroke="#38bdf8"
            strokeWidth={markerStroke}
          />
        </g>
      </svg>
    </div>
  );
}
