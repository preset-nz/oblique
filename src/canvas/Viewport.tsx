import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useRef } from 'react';
import { importFiles, tauriImportDeps } from '@/project/import';
import { useCacheVersionStore } from '@/scene/cache';
import { useSceneStore } from '@/scene/store';
import {
  blitScene,
  computeBufferSize,
  DISPLAY_LEVEL,
  ensureBuffer,
  recompositeBuffer,
  viewChangeNeedsRecomposite,
} from './paintScene';
import { usePanZoom } from './usePanZoom';
import { screenToDoc, useViewTransformStore } from './viewTransform';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dprRef = useRef(1);
  // Selecting `view` re-renders this component on every pan/zoom tick so the
  // SVG overlay's transform attribute stays in lockstep with the canvas
  // paint. That's one cheap attribute update per frame, not a full repaint.
  const view = useViewTransformStore((state) => state.view);
  // Offscreen composite buffer at WORKING resolution — rebuilt only when
  // `recompute` is true (scene/documentSize/cache change), reused as-is on
  // every pan/zoom tick (architecture.md §Compositor: "pan/zoom never
  // triggers a recomposite").
  const bufferRef = useRef<OffscreenCanvas | null>(null);

  usePanZoom(canvasRef);

  const paint = useCallback((recompute: boolean) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = dprRef.current;
    const { view: currentView, docW, docH } = useViewTransformStore.getState();

    if (recompute) {
      const [bufW, bufH] = computeBufferSize(docW, docH, DISPLAY_LEVEL);
      bufferRef.current = ensureBuffer(bufferRef.current, bufW, bufH);
      recompositeBuffer(bufferRef.current, useSceneStore.getState().scene, DISPLAY_LEVEL);
    }

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
    blitScene(ctx, bufferRef.current, docW, docH);
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
      paint(true);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [paint]);

  // Coalesce store-driven repaints (pan/zoom, doc size, scene/order/visibility
  // changes, freshly-cooked caches) into one rAF per frame. `recompute`
  // latches true for the frame if *any* trigger since the last paint needed
  // one — a pure `view`-only change (pan/zoom) never sets it, so a
  // pan-then-zoom burst still reblits without recompositing.
  useEffect(() => {
    let rafId: number | null = null;
    let recomputePending = false;
    const schedule = (recompute: boolean) => {
      if (recompute) recomputePending = true;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const recomputeNow = recomputePending;
        recomputePending = false;
        paint(recomputeNow);
      });
    };
    // cursorDoc updates every pointermove and must not reach the canvas paint path.
    const unsubscribeView = useViewTransformStore.subscribe((state, prev) => {
      if (viewChangeNeedsRecomposite(prev, state)) {
        schedule(true);
      } else if (state.view !== prev.view) {
        schedule(false);
      }
    });
    // Order/visibility/opacity/blend/documentSize mutations swap the scene
    // object reference — compositing-only, no dirty flag (dirty rule 4), but
    // still needs a recomposite.
    const unsubscribeScene = useSceneStore.subscribe((state, prev) => {
      if (state.scene !== prev.scene) schedule(true);
    });
    // Any cook writing a fresh bitmap bumps cacheVersion.
    const unsubscribeCache = useCacheVersionStore.subscribe(() => schedule(true));
    return () => {
      unsubscribeView();
      unsubscribeScene();
      unsubscribeCache();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [paint]);

  const overlayMatrix = `matrix(${view.scale} 0 0 ${view.scale} ${view.tx} ${view.ty})`;

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
        {/* Document-space overlay group; empty until Epic 05/06 (selection, vectors). */}
        <g transform={overlayMatrix} />
      </svg>
    </div>
  );
}
