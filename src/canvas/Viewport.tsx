import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useRef } from 'react';
import { destSizeFor } from '@/compositor/composite';
import { importFiles, tauriImportDeps } from '@/project/import';
import { useCacheVersionStore } from '@/scene/cache';
import { beginTransaction, endTransaction } from '@/scene/history';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { IDENTITY_TRANSFORM_2D } from '@/scene/types';
import { topmostNodeAt } from './hitTest';
import {
  blitScene,
  computeBufferSize,
  DISPLAY_LEVEL,
  ensureBuffer,
  recompositeBuffer,
  viewChangeNeedsRecomposite,
} from './paintScene';
import { TransformBox } from './TransformBox';
import { useToolStateStore } from './toolState';
import { applyMove, type Point } from './transform2d';
import { usePanZoom } from './usePanZoom';
import { panBy, screenToDoc, useViewTransformStore } from './viewTransform';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

/** Document-px direction per arrow key for the selected-node nudge. */
const NUDGE_DELTA: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

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

  const selection = useSelectionStore((s) => s.selection);
  const selectNode = useSelectionStore((s) => s.selectNode);
  const clearSelection = useSelectionStore((s) => s.clear);
  const setNodeTransform = useSceneStore((s) => s.setNodeTransform);
  const tool = useToolStateStore((s) => s.tool);
  const selectedNodeId = selection.kind === 'node' ? selection.nodeId : null;

  /** Client coords -> document space, sharing the same view transform as canvas paint. */
  const toDoc = useCallback((clientX: number, clientY: number): Point => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    const { view: currentView } = useViewTransformStore.getState();
    return screenToDoc(currentView, { x: clientX - rect.left, y: clientY - rect.top });
  }, []);

  // Tool-gated pointer handlers (tool-state.md replaces the node-transform-2d
  // interim). usePanZoom keeps owning space-held/middle-button pan untouched
  // under every tool; this effect adds the branch in front of it per the
  // story's "Components touched" line: a plain left-button pointerdown here
  // starts a pan when `tool === 'pan'`, or a move-drag when `tool === 'move'`
  // (marquee tools are a no-op until marquees.md).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let spaceHeld = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld = true;
        return;
      }

      const target = e.target;
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // Escape clears node selection from any tool (de-select, tool-state.md).
      // Selection is UI state — clearing it never touches the scene store,
      // so it can never create an undo step.
      if (e.key === 'Escape' && !isEditableTarget) {
        clearSelection();
        return;
      }

      // Arrow-key nudge: 1 px, Shift = 10 px (node-transform-2d.md §Tools).
      // Skipped while a text field has focus — InputNumber owns ArrowUp/Down
      // for value stepping there. Each keydown is its own undo step (the
      // store-subscribe capture coalesces nothing outside a transaction).
      const step = NUDGE_DELTA[e.key];
      if (!step || selection.kind !== 'node' || tool !== 'move') return;
      if (isEditableTarget) return;
      const node = useSceneStore.getState().scene.nodes.find((n) => n.id === selection.nodeId);
      if (!node) return;
      e.preventDefault();
      const px = e.shiftKey ? 10 : 1;
      setNodeTransform(
        node.id,
        applyMove(node.transform2d ?? IDENTITY_TRANSFORM_2D, {
          x: step[0] * px,
          y: step[1] * px,
        }),
      );
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld = false;
    };

    let dragNodeId: string | null = null;
    let dragStartTransform = IDENTITY_TRANSFORM_2D;
    let dragStartDoc: Point = { x: 0, y: 0 };

    // Plain left-drag pan for the pan tool. Screen-space delta tracking,
    // same shape as usePanZoom's own space/middle-button pan — deliberately
    // not routed through usePanZoom.ts (left untouched per the story) so
    // Epic 01's space/middle-button gestures keep their own independent path.
    let panning = false;
    let panLastScreen: Point = { x: 0, y: 0 };
    // Distinguishes a click (select, Georg 2026-07-05: clicking a node should
    // select it under the pan tool too) from a drag (pan) — screen px.
    let panTravel = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || spaceHeld) return; // let usePanZoom own space/middle-button drags

      if (tool === 'pan') {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        panning = true;
        panTravel = 0;
        panLastScreen = { x: e.clientX, y: e.clientY };
        return;
      }

      if (tool !== 'move') return; // marquee tools: no drag yet (marquees.md)

      const docPt = toDoc(e.clientX, e.clientY);
      const hit = topmostNodeAt(useSceneStore.getState().scene, docPt);
      if (!hit) {
        // De-select: click on empty canvas with the move tool active
        // (tool-state.md). UI-only, never touches the scene store.
        if (selection.kind === 'node') clearSelection();
        return;
      }

      if (selection.kind !== 'node' || selection.nodeId !== hit.id) {
        selectNode(hit.id);
      }

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      dragNodeId = hit.id;
      dragStartTransform = hit.transform2d ?? IDENTITY_TRANSFORM_2D;
      dragStartDoc = docPt;
      beginTransaction();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (panning) {
        const dx = e.clientX - panLastScreen.x;
        const dy = e.clientY - panLastScreen.y;
        panTravel += Math.abs(dx) + Math.abs(dy);
        panLastScreen = { x: e.clientX, y: e.clientY };
        const { view, setView } = useViewTransformStore.getState();
        setView(panBy(view, dx, dy));
        return;
      }
      if (!dragNodeId) return;
      const docPt = toDoc(e.clientX, e.clientY);
      const next = applyMove(dragStartTransform, {
        x: docPt.x - dragStartDoc.x,
        y: docPt.y - dragStartDoc.y,
      });
      setNodeTransform(dragNodeId, next);
    };

    const endDrag = (e: PointerEvent) => {
      if (panning) {
        canvas.releasePointerCapture(e.pointerId);
        panning = false;
        // A stationary press is a click, not a pan: select what's under it
        // (or clear on empty canvas) — same semantics as the move tool.
        if (panTravel <= 4) {
          const hit = topmostNodeAt(useSceneStore.getState().scene, toDoc(e.clientX, e.clientY));
          if (hit) selectNode(hit.id);
          else if (selection.kind === 'node') clearSelection();
        }
        return;
      }
      if (!dragNodeId) return;
      canvas.releasePointerCapture(e.pointerId);
      dragNodeId = null;
      endTransaction();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
    };
  }, [selection, selectNode, clearSelection, setNodeTransform, tool, toDoc]);

  const selectedNode = useSceneStore((s) =>
    selectedNodeId ? s.scene.nodes.find((n) => n.id === selectedNodeId) : undefined,
  );
  const documentSize = useSceneStore((s) => s.scene.documentSize);

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
        {/* Document-space overlay group; TransformBox is the only occupant until
            marquees/vector editing land (Epic 05/06). */}
        <g transform={overlayMatrix}>
          {selectedNode && selectedNode.output === 'image' && (
            <TransformBox
              node={selectedNode}
              extent={{
                w: destSizeFor(selectedNode, 'baked', documentSize)[0],
                h: destSizeFor(selectedNode, 'baked', documentSize)[1],
              }}
              viewScale={view.scale}
              toDoc={toDoc}
            />
          )}
        </g>
      </svg>
    </div>
  );
}
