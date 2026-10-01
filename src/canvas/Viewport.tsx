import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useRef } from 'react';
import { destSizeFor } from '@/compositor/composite';
import { importFiles, tauriImportDeps } from '@/project/import';
import { useCacheVersionStore } from '@/scene/cache';
import { beginTransaction, endTransaction } from '@/scene/history';
import {
  fillRuleForMarquee,
  isMaskableMarquee,
  marqueeToVectorPaths,
  useMarqueeStateStore,
} from '@/scene/marquee';
import { usePathEditStateStore } from '@/scene/pathEditState';
import { useSelectionStore } from '@/scene/selection';
import { useSceneStore } from '@/scene/store';
import { IDENTITY_TRANSFORM_2D, isTextNode, isVectorNode } from '@/scene/types';
import { ColourSelectOverlay } from './colourSelect/ColourSelectOverlay';
import { ColourSelectParamsPanel } from './colourSelect/ColourSelectParamsPanel';
import { ColourSelectStatusPanel } from './colourSelect/ColourSelectStatusPanel';
import { ColourSelectController } from './colourSelect/controller';
import { useColourSelectStore } from './colourSelect/state';
import { topmostNodeAt } from './hitTest';
import { EllipseMarquee } from './marquees/EllipseMarquee';
import { LassoMarquee } from './marquees/LassoMarquee';
import { MarqueeToolbar } from './marquees/MarqueeToolbar';
import {
  appendLassoPoint,
  isDrawnLasso,
  isDrawnRect,
  isNearStart,
  rectFromDrag,
} from './marquees/marqueeGeometry';
import { RectMarquee } from './marquees/RectMarquee';
import {
  blitScene,
  computeBufferSize,
  DISPLAY_LEVEL,
  ensureBuffer,
  recompositeBuffer,
  viewChangeNeedsRecomposite,
} from './paintScene';
import { getTargetFrame } from './selectShared/payload';
import { SmartSelectController } from './smartSelect/controller';
import { resolveOutlineSeed } from './smartSelect/outlinePrompt';
import { SmartSelectOverlay } from './smartSelect/SmartSelectOverlay';
import { SmartSelectStatusPanel } from './smartSelect/SmartSelectStatusPanel';
import { useSmartSelectStore } from './smartSelect/state';
import { TransformBox } from './TransformBox';
import { TextBounds } from './text/TextBounds';
import { TextEditor } from './text/TextEditor';
import { beginNewTextAt, beginReEdit, commitActiveTextEdit } from './text/textEditState';
import { type ClickRecord, isDoubleClick } from './text/textFrame';
import { useToolStateStore } from './toolState';
import { applyMove, type Point } from './transform2d';
import { usePanZoom } from './usePanZoom';
import { PathEditor } from './vector/PathEditor';
import { PenTool } from './vector/PenTool';
import { deleteAnchor } from './vector/pathEdit';
import { MIN_ANCHORS_TO_CLOSE, usePenStateStore } from './vector/penState';
import { panBy, screenToDoc, useViewTransformStore } from './viewTransform';

/** Screen-space drag threshold that tells a smart-select click (a point) apart from a drag (a box) — segment-to-vector.md's "drag >= 4px = box". */
const SMART_SELECT_DRAG_SCREEN_PX = 4;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

/** Document-px direction per arrow key for the selected-node nudge. */
const NUDGE_DELTA: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Screen-space "snap closed" radius for the lasso's return-to-start check — converted to a document-space threshold via the live view scale so it feels constant at any zoom (marqueeGeometry.ts's `isNearStart` itself is pure document-space). */
const LASSO_CLOSE_SCREEN_PX = 8;

/** Screen-space "click the first anchor closes the path" radius for the pen tool — same conversion idiom as `LASSO_CLOSE_SCREEN_PX`, reusing `isNearStart` (pure point-distance, not marquee-specific). */
const PEN_CLOSE_SCREEN_PX = 8;

/** Screen-space movement threshold that tells a plain click (corner anchor) apart from a click-drag (smooth anchor, pen-tool.md). */
const PEN_DRAG_SCREEN_PX = 3;

/**
 * Whether an Enter keydown aimed at `target` may open the text editor: focus
 * on nothing in particular (body) or on the layer list, never on another
 * control that wants Enter for itself.
 */
function canEditTextFrom(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target === document.body) return true;
  return target.closest('[data-layer-list]') !== null;
}

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
  // Last primary pointerdown on a node under the move tool, for double-click
  // detection from Pointer Events alone (no `dblclick`). A ref, not a local in
  // the pointer effect: that effect re-runs on selection/tool changes, and the
  // first click's own `selectNode` would wipe a local.
  const lastClickRef = useRef<ClickRecord | null>(null);

  usePanZoom(canvasRef);

  const selection = useSelectionStore((s) => s.selection);
  const selectNode = useSelectionStore((s) => s.selectNode);
  const clearSelection = useSelectionStore((s) => s.clear);
  const setNodeTransform = useSceneStore((s) => s.setNodeTransform);
  const tool = useToolStateStore((s) => s.tool);
  const selectedNodeId = selection.kind === 'node' ? selection.nodeId : null;

  const marquee = useMarqueeStateStore((s) => s.marquee);
  const setMarquee = useMarqueeStateStore((s) => s.setMarquee);
  const clearMarquee = useMarqueeStateStore((s) => s.clear);

  const penAnchors = usePenStateStore((s) => s.anchors);
  const cancelPen = usePenStateStore((s) => s.cancel);

  const smartPoints = useSmartSelectStore((s) => s.points);
  const smartBox = useSmartSelectStore((s) => s.box);

  const colourSeeds = useColourSelectStore((s) => s.seeds);

  // Debounced sidecar `segment` requests for the smart-select prompt
  // (segment-to-vector.md) — one controller for the Viewport's lifetime,
  // same "start once, react to the store" shape as the app-wide
  // `CookScheduler`, just view-local since the prompt itself is view-local.
  useEffect(() => {
    const controller = new SmartSelectController();
    controller.start();
    return () => controller.stop();
  }, []);

  // Same shape for `select-colour`'s prompt (colour-range-select.md) — a
  // separate controller instance, not a merge with `SmartSelectController`:
  // different store, different (model-free) request shape.
  useEffect(() => {
    const controller = new ColourSelectController();
    controller.start();
    return () => controller.stop();
  }, []);

  // Tool-switch-away clears the marquee and the in-progress pen path (epic
  // acceptance: "no orphaned overlay state"). Reactive on `tool` rather than
  // living inside `setTool` itself — covers both the `M`/`V` shortcuts
  // (app/shortcuts.ts) and ToolbarRail clicks without toolState.ts needing
  // to know marquees/pen exist. Every tool change clears (including
  // switching between the three marquee tools themselves — "one active
  // marquee at a time" per tool — and switching away from `pen` mid-draw).
  const prevToolRef = useRef(tool);
  useEffect(() => {
    if (prevToolRef.current !== tool) {
      // Activating select-smart (segment-to-vector.md's outline prompt):
      // seed the first request from whatever outline is already on offer —
      // an active marquee, or a selected vector node's own paths — BEFORE
      // clearMarquee() below consumes it. Read directly off the stores
      // (not the render-time `marquee`/`selectedNode` values) so this
      // effect's own deps don't need to widen.
      if (tool === 'select-smart') {
        const activeMarquee = useMarqueeStateStore.getState().marquee;
        const selection = useSelectionStore.getState().selection;
        const node =
          selection.kind === 'node'
            ? useSceneStore.getState().scene.nodes.find((n) => n.id === selection.nodeId)
            : undefined;
        const targetId =
          node && (node.type === 'pixel' || node.type === 'vector' || node.type === 'text')
            ? node.id
            : null;
        useSmartSelectStore.getState().setTarget(targetId);

        if (targetId) {
          // Only the mapping frame is needed to seed the outline (its own
          // pixel bytes aren't) — `getTargetFrame` skips the OffscreenCanvas
          // readback `getTargetPayload`/`fire()` pays for 150ms later.
          const frame = getTargetFrame(targetId);
          if (frame) {
            const outline =
              activeMarquee && isMaskableMarquee(activeMarquee)
                ? {
                    paths: marqueeToVectorPaths(activeMarquee),
                    // fillRuleForMarquee, not a hardcoded 'nonzero': a
                    // `polygons` marquee active here could be a
                    // colour-range-select.md preview with holes (Escape
                    // wasn't pressed before switching tools) — evenodd
                    // keeps the coarse mask this seeds SAM's decoder with
                    // consistent with how the shape actually rasterises
                    // once committed (store.ts).
                    fillRule: fillRuleForMarquee(activeMarquee),
                  }
                : node && isVectorNode(node)
                  ? { paths: node.paths, fillRule: node.fillRule }
                  : undefined;
            const seed = outline && resolveOutlineSeed(outline.paths, outline.fillRule, frame);
            if (seed) {
              // OUTLINE_PROMPT_USES_MASK (sidecar dogfooding note,
              // outlinePrompt.ts): box-only by default — `seed.mask` is
              // `null` unless that flag is flipped back on.
              if (seed.mask) {
                useSmartSelectStore.getState().seedOutline(seed.box, seed.mask);
              } else {
                useSmartSelectStore.getState().setBox(seed.box);
              }
            }
          } else {
            // Nothing cooked yet to segment — honest status instead of a
            // silent dead tool (epic acceptance: "never a silent failure").
            useSmartSelectStore.getState().setStatus('error', 'Nothing cooked to segment yet');
          }
        } else {
          useSmartSelectStore
            .getState()
            .setStatus('error', 'Select an image or vector layer to segment');
        }
      }
      if (prevToolRef.current === 'select-smart') {
        useSmartSelectStore.getState().clear();
      }

      // Activating select-colour (colour-range-select.md): no outline seed
      // (the wand has no box/mask prompt to consume) — just pick the
      // target node the same way select-smart does.
      if (tool === 'select-colour') {
        const selection = useSelectionStore.getState().selection;
        const node =
          selection.kind === 'node'
            ? useSceneStore.getState().scene.nodes.find((n) => n.id === selection.nodeId)
            : undefined;
        const targetId =
          node && (node.type === 'pixel' || node.type === 'vector' || node.type === 'text')
            ? node.id
            : null;
        useColourSelectStore.getState().setTarget(targetId);
        if (!targetId) {
          useColourSelectStore
            .getState()
            .setStatus('error', 'Select an image or vector layer to select from');
        }
      }
      if (prevToolRef.current === 'select-colour') {
        useColourSelectStore.getState().clear();
      }

      clearMarquee();
      cancelPen();
      // Same "no orphaned overlay state" rule for path-editing.md's active
      // anchor — a tool switch away from move (or to a different node's
      // move-select) shouldn't leave a stale anchor selection behind.
      usePathEditStateStore.getState().clear();
    }
    prevToolRef.current = tool;
  }, [tool, clearMarquee, cancelPen]);

  // Selecting a different node invalidates any active anchor from the
  // PREVIOUS selection (its path/anchor indices belong to a different
  // node's `paths` array) — clear on every selection change, not just tool
  // switches.
  const prevSelectedNodeIdRef = useRef(selectedNodeId);
  useEffect(() => {
    if (prevSelectedNodeIdRef.current !== selectedNodeId) {
      usePathEditStateStore.getState().clear();
    }
    prevSelectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

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
      const target = e.target;
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.code === 'Space') {
        if (!isEditableTarget) spaceHeld = true;
        return;
      }

      // Escape clears node selection from any tool (de-select, tool-state.md),
      // the active marquee (marquees.md), and cancels an in-progress pen
      // path (pen-tool.md — "no scene mutation"). All three are UI-only
      // state — none of them ever touches the scene store, so none can
      // create an undo step.
      //
      // path-editing.md's active anchor takes precedence: Escape deselects
      // the anchor FIRST (one step back, same as a marquee's own escape
      // hierarchy would be if it had one), only falling through to
      // node-deselect once no anchor is active. An in-flight anchor/handle
      // drag cancels itself independently — `PathEditor.tsx` registers its
      // own transient Escape listener for the duration of a drag, which
      // fires regardless of this handler's own effects (neither touches the
      // other's state).
      if (e.key === 'Escape' && !isEditableTarget) {
        if (usePathEditStateStore.getState().activeAnchor) {
          usePathEditStateStore.getState().clear();
          return;
        }
        clearSelection();
        clearMarquee();
        usePenStateStore.getState().cancel();
        // select-smart's own prompt (segment-to-vector.md) — same
        // "no orphaned overlay state" rule; clearMarquee() above already
        // drops the polygons preview it writes there. `clearPrompt` (not
        // `clear`) keeps the tool's target: Escape drops the prompt, not
        // the whole tool — a second Escape or a stray click shouldn't need
        // a tool-switch round trip to work again.
        if (tool === 'select-smart') useSmartSelectStore.getState().clearPrompt();
        // select-colour's own prompt (colour-range-select.md) — same rule.
        if (tool === 'select-colour') useColourSelectStore.getState().clearPrompt();
        return;
      }

      // Enter finishes the in-progress pen path (pen-tool.md): closes it
      // with >= 3 anchors, finishes it open with exactly 2, no-ops
      // otherwise. Reads the store directly (not the `penAnchors` render
      // value) for the same reason the Delete/marquee branch below does —
      // this effect shouldn't re-run on every anchor placed.
      if (e.key === 'Enter' && !isEditableTarget && tool === 'pen') {
        e.preventDefault();
        usePenStateStore.getState().finishOnEnter();
        return;
      }

      // Enter re-opens the selected, unlocked text node's overlay editor
      // (text-tool-and-inspector.md) — the only way into mask-output text,
      // which hit-testing skips. Only when focus is on the canvas side or the
      // layer list, so Enter still activates other focused buttons.
      if (e.key === 'Enter' && !e.repeat && !isEditableTarget && canEditTextFrom(target)) {
        const currentSelection = useSelectionStore.getState().selection;
        if (currentSelection.kind === 'node' && beginReEdit(currentSelection.nodeId)) {
          e.preventDefault();
          return;
        }
      }

      // Delete/Backspace removes the active anchor (path-editing.md), or
      // failing that clears the active marquee (marquees.md — "no orphaned
      // overlay state"). Node deletion outside these two isn't bound to a
      // keyboard shortcut yet (`scene/deleteNode.ts` is menu/panel-driven
      // only). Reads stores directly (rather than closing over render
      // values) so this effect doesn't need `marquee`/`selection` churn in
      // its dependency array — re-running this whole effect mid-drag would
      // discard the local drag-state closures below.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditableTarget) {
        const activeAnchor = usePathEditStateStore.getState().activeAnchor;
        const currentSelection = useSelectionStore.getState().selection;
        if (activeAnchor && currentSelection.kind === 'node') {
          e.preventDefault();
          const node = useSceneStore
            .getState()
            .scene.nodes.find((n) => n.id === currentSelection.nodeId);
          usePathEditStateStore.getState().clear();
          if (node && isVectorNode(node)) {
            const result = deleteAnchor(
              node.paths,
              activeAnchor.pathIndex,
              activeAnchor.anchorIndex,
            );
            if (result === null) {
              useSceneStore.getState().removeNode(node.id);
              clearSelection();
            } else {
              useSceneStore.getState().setVectorPaths(node.id, result);
            }
          }
          return;
        }
        if (useMarqueeStateStore.getState().marquee) {
          e.preventDefault();
          clearMarquee();
          if (tool === 'select-smart') useSmartSelectStore.getState().clearPrompt();
          if (tool === 'select-colour') useColourSelectStore.getState().clearPrompt();
          return;
        }
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

    // Marquee draw state (marquees.md). A canvas-level pointerdown here only
    // ever *starts a new* rect/ellipse/lasso draw: clicking inside an
    // already-drawn marquee's body or a handle is captured first by that
    // marquee's own SVG element (`MarqueeBox`/`LassoMarquee`, pointer-events
    // auto) sitting on top of the canvas, so this handler never sees those
    // events — no hit-testing needed here to tell "start new" from "grab
    // existing" apart.
    let rectDrawAnchor: Point | null = null;
    let lassoDrawing = false;
    let lassoStart: Point = { x: 0, y: 0 };
    // Return-to-start may only close the lasso once the pointer has LEFT
    // the start's snap radius: the first few pointermoves of any drag are
    // still inside it, so without this guard the path self-closed as an
    // invisible 3-point speck a couple of pixels in.
    let lassoLeftStart = false;

    // Pen draw state (pen-tool.md). A pointerdown always either closes the
    // path (click on the first anchor, >= 3 anchors already placed) or opens
    // a *pending* anchor — corner vs. smooth is only decided at pointerup,
    // once we know whether the pointer moved (drag) or not (click).
    let penPendingAnchor: Point | null = null;
    let penPendingMoved = false;

    // Smart-select draw state (segment-to-vector.md). Every pointerdown is
    // *pending* until pointerup/move decides click (a point) vs. drag (a
    // box) — same click-vs-drag deferral as the pen tool's own pending
    // anchor above, just with a document-space distance threshold instead
    // of a boolean.
    let smartPendingStart: Point | null = null;
    let smartPendingAlt = false;
    let smartPendingMoved = false;

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

      if (tool === 'select-rect' || tool === 'select-ellipse') {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        const docPt = toDoc(e.clientX, e.clientY);
        rectDrawAnchor = docPt;
        setMarquee({
          kind: tool === 'select-rect' ? 'rect' : 'ellipse',
          rect: { x: docPt.x, y: docPt.y, w: 0, h: 0 },
        });
        return;
      }

      if (tool === 'select-lasso') {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        const docPt = toDoc(e.clientX, e.clientY);
        lassoDrawing = true;
        lassoStart = docPt;
        lassoLeftStart = false;
        setMarquee({ kind: 'lasso', points: [docPt], closed: false });
        return;
      }

      if (tool === 'select-smart') {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        smartPendingStart = toDoc(e.clientX, e.clientY);
        smartPendingAlt = e.altKey;
        smartPendingMoved = false;
        return;
      }

      // select-colour (colour-range-select.md): a single click, no
      // drag/box concept — click = positive seed (replaces the current
      // set), Alt-click = negative, Shift-click ADDS to the current set
      // instead of replacing it (the story's own fixed contract).
      if (tool === 'select-colour') {
        e.preventDefault();
        const docPt = toDoc(e.clientX, e.clientY);
        const label: 0 | 1 = e.altKey ? 0 : 1;
        if (e.shiftKey) {
          useColourSelectStore.getState().addSeed(docPt, label);
        } else {
          useColourSelectStore.getState().setSeed(docPt, label);
        }
        return;
      }

      if (tool === 'pen') {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        const docPt = toDoc(e.clientX, e.clientY);
        const anchors = usePenStateStore.getState().anchors;
        const viewScale = useViewTransformStore.getState().view.scale;
        const closeThresholdDoc = PEN_CLOSE_SCREEN_PX / Math.max(viewScale, 0.0001);
        if (
          anchors.length >= MIN_ANCHORS_TO_CLOSE &&
          isNearStart(docPt, anchors[0].point, closeThresholdDoc)
        ) {
          usePenStateStore.getState().finishClosed();
          return;
        }
        penPendingAnchor = docPt;
        penPendingMoved = false;
        return;
      }

      // Text tool (text-tool-and-inspector.md): commit any open edit first (the
      // TextEditor's capture-phase listener has normally done it already — it
      // is idempotent), then re-edit the unlocked text under the pointer, or
      // place a new blank node. preventDefault so this pointerdown can't pull
      // focus back out of the textarea the edit is about to mount.
      if (tool === 'text') {
        e.preventDefault();
        commitActiveTextEdit();
        const docPt = toDoc(e.clientX, e.clientY);
        const hit = topmostNodeAt(useSceneStore.getState().scene, docPt);
        if (hit && isTextNode(hit) && hit.state !== 'locked') {
          beginReEdit(hit.id);
        } else {
          beginNewTextAt(docPt);
        }
        return;
      }

      if (tool !== 'move') return;

      const docPt = toDoc(e.clientX, e.clientY);
      const hit = topmostNodeAt(useSceneStore.getState().scene, docPt);

      // Double-click on unlocked text re-edits it. Checked BEFORE the drag
      // branch below: its beginTransaction() would otherwise flush the edit's
      // own transaction. A locked node falls through (and does nothing here).
      const click: ClickRecord | null = hit
        ? { t: e.timeStamp, x: e.clientX, y: e.clientY, nodeId: hit.id }
        : null;
      const previousClick = lastClickRef.current;
      lastClickRef.current = click;
      if (
        hit &&
        click &&
        isTextNode(hit) &&
        hit.state !== 'locked' &&
        isDoubleClick(previousClick, click)
      ) {
        lastClickRef.current = null;
        e.preventDefault();
        beginReEdit(hit.id);
        return;
      }

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

      if (rectDrawAnchor) {
        const docPt = toDoc(e.clientX, e.clientY);
        const kind = tool === 'select-rect' ? 'rect' : 'ellipse';
        setMarquee({
          kind,
          rect: rectFromDrag(rectDrawAnchor, docPt, { square: e.shiftKey, fromCentre: e.altKey }),
        });
        return;
      }

      if (lassoDrawing) {
        const docPt = toDoc(e.clientX, e.clientY);
        const current = useMarqueeStateStore.getState().marquee;
        const points = current?.kind === 'lasso' ? current.points : [lassoStart];
        const viewScale = useViewTransformStore.getState().view.scale;
        const closeThresholdDoc = LASSO_CLOSE_SCREEN_PX / Math.max(viewScale, 0.0001);
        const nearStart = isNearStart(docPt, lassoStart, closeThresholdDoc);
        if (!nearStart) lassoLeftStart = true;
        if (lassoLeftStart && nearStart && isDrawnLasso(points)) {
          lassoDrawing = false;
          setMarquee({ kind: 'lasso', points, closed: true });
          return;
        }
        setMarquee({ kind: 'lasso', points: appendLassoPoint(points, docPt), closed: false });
        return;
      }

      if (smartPendingStart) {
        const docPt = toDoc(e.clientX, e.clientY);
        const viewScale = useViewTransformStore.getState().view.scale;
        const dragThresholdDoc = SMART_SELECT_DRAG_SCREEN_PX / Math.max(viewScale, 0.0001);
        const dx = docPt.x - smartPendingStart.x;
        const dy = docPt.y - smartPendingStart.y;
        if (dx * dx + dy * dy > dragThresholdDoc * dragThresholdDoc) smartPendingMoved = true;
        if (smartPendingMoved) {
          useSmartSelectStore.getState().setBox({
            x0: smartPendingStart.x,
            y0: smartPendingStart.y,
            x1: docPt.x,
            y1: docPt.y,
          });
        }
        return;
      }

      if (tool === 'pen') {
        const docPt = toDoc(e.clientX, e.clientY);
        // Rubber-band target updates on every move, dragging an anchor's
        // handle or not — it's the segment from the last COMMITTED anchor
        // to the live cursor (pen-tool.md).
        usePenStateStore.getState().setCursor(docPt);
        if (penPendingAnchor) {
          const viewScale = useViewTransformStore.getState().view.scale;
          const dragThresholdDoc = PEN_DRAG_SCREEN_PX / Math.max(viewScale, 0.0001);
          const dx = docPt.x - penPendingAnchor.x;
          const dy = docPt.y - penPendingAnchor.y;
          if (dx * dx + dy * dy > dragThresholdDoc * dragThresholdDoc) penPendingMoved = true;
        }
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

      if (rectDrawAnchor) {
        canvas.releasePointerCapture(e.pointerId);
        rectDrawAnchor = null;
        // A plain click (no drag) never grew the rect past a stray-click
        // size — discard it rather than leaving a zero-size box with 8
        // stacked handles and a floating toolbar behind (epic acceptance:
        // "no orphaned overlay state").
        const current = useMarqueeStateStore.getState().marquee;
        if (
          (current?.kind === 'rect' || current?.kind === 'ellipse') &&
          !isDrawnRect(current.rect)
        ) {
          clearMarquee();
        }
        return;
      }

      if (lassoDrawing) {
        canvas.releasePointerCapture(e.pointerId);
        lassoDrawing = false;
        const current = useMarqueeStateStore.getState().marquee;
        if (current?.kind === 'lasso') {
          // Same "no orphaned overlay state" rule as the rect/ellipse
          // branch above: a stray click never accumulated enough points to
          // be a real shape.
          if (!isDrawnLasso(current.points)) {
            clearMarquee();
          } else if (!current.closed) {
            // Release always closes, even short of the return-to-start
            // snap (acceptance: "closes on return-to-start or release").
            setMarquee({ kind: 'lasso', points: current.points, closed: true });
          }
        }
        return;
      }

      if (smartPendingStart) {
        canvas.releasePointerCapture(e.pointerId);
        // A drag already wrote the box live in onPointerMove — only a
        // stationary press (no drag) becomes a point here (click = positive,
        // Alt-click = negative, segment-to-vector.md).
        if (!smartPendingMoved) {
          useSmartSelectStore.getState().addPoint(smartPendingStart, smartPendingAlt ? 0 : 1);
        }
        smartPendingStart = null;
        smartPendingMoved = false;
        return;
      }

      if (penPendingAnchor) {
        canvas.releasePointerCapture(e.pointerId);
        const docPt = toDoc(e.clientX, e.clientY);
        if (penPendingMoved) {
          usePenStateStore.getState().placeSmooth(penPendingAnchor, docPt);
        } else {
          usePenStateStore.getState().placeCorner(penPendingAnchor);
        }
        penPendingAnchor = null;
        penPendingMoved = false;
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
  }, [
    selection,
    selectNode,
    clearSelection,
    setNodeTransform,
    tool,
    toDoc,
    setMarquee,
    clearMarquee,
  ]);

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
        {/* Document-space overlay group: TransformBox/PathEditor (move tool
            only — see below) and the active marquee (Epic 05), siblings
            here per the story's "Components touched" line. */}
        <g transform={overlayMatrix}>
          {/* Gated to the move tool: under a marquee tool the marquee's own
              handles occupy this same overlay space, and TransformBox's 8
              handles + a marquee's would otherwise overlap ambiguously.
              tool-state.md didn't exist when TransformBox was written (its
              own doc comment notes the "always live" interim); Viewport's
              own move-drag gesture above is already tool-gated the same
              way. TransformBox itself is unchanged — only when Viewport
              chooses to render it changes.

              A selected VECTOR node gets `PathEditor` INSTEAD of
              TransformBox (path-editing.md's "honest v1" call, flagged in
              the story report): the two overlays would fight for the same
              click targets (8 scale/rotate handles vs. per-anchor editing),
              so direct-selection path editing replaces the transform box
              entirely for vector nodes, regardless of `output`
              ('image' or 'mask' — a mask-output vector is still editable).
              Plain body drag-to-move keeps working underneath either way —
              that's Viewport's own pointerdown hit-test above, independent
              of which overlay is mounted.

              Locked nodes (lock-ui.md) get neither: transform2d/path edits
              are store-guarded anyway (lock-state-machine.md), so showing
              handles that refuse to move would be dishonest UI. Selection/
              hit-testing above is untouched — a locked node still selects,
              it just draws no overlay. Checked inline (`state === 'locked'`)
              rather than via a panels/stack helper — src/canvas/ and
              src/panels/ never import each other (depcruise). */}
          {tool === 'move' &&
            selectedNode &&
            selectedNode.state !== 'locked' &&
            !isTextNode(selectedNode) &&
            (isVectorNode(selectedNode) ? (
              <PathEditor
                node={selectedNode}
                viewScale={view.scale}
                toDoc={toDoc}
                extent={{ w: documentSize[0], h: documentSize[1] }}
              />
            ) : (
              selectedNode.output === 'image' && (
                <TransformBox
                  node={selectedNode}
                  extent={{
                    w: destSizeFor(selectedNode, 'baked', documentSize)[0],
                    h: destSizeFor(selectedNode, 'baked', documentSize)[1],
                  }}
                  viewScale={view.scale}
                  toDoc={toDoc}
                />
              )
            ))}
          {/* A TEXT node gets TextBounds (its glyph bounds) INSTEAD of
              TransformBox, which would frame the whole document-sized
              raster (text-tool-and-inspector.md). Scale/rotate is done with
              font size or Convert to Outlines; moving still works through
              the body drag above. Shown under the text tool too. */}
          {(tool === 'move' || tool === 'text') &&
            selectedNode &&
            isTextNode(selectedNode) &&
            selectedNode.state !== 'locked' && (
              <TextBounds node={selectedNode} viewScale={view.scale} documentSize={documentSize} />
            )}
          {marquee?.kind === 'rect' && (
            <RectMarquee rect={marquee.rect} viewScale={view.scale} toDoc={toDoc} />
          )}
          {marquee?.kind === 'ellipse' && (
            <EllipseMarquee rect={marquee.rect} viewScale={view.scale} toDoc={toDoc} />
          )}
          {marquee?.kind === 'lasso' && (
            <LassoMarquee
              points={marquee.points}
              closed={marquee.closed}
              viewScale={view.scale}
              toDoc={toDoc}
            />
          )}
          {tool === 'pen' && penAnchors.length > 0 && <PenTool viewScale={view.scale} />}
          {tool === 'select-smart' && (
            <SmartSelectOverlay
              points={smartPoints}
              box={smartBox}
              polygons={marquee?.kind === 'polygons' ? marquee.polygons : []}
              viewScale={view.scale}
            />
          )}
          {tool === 'select-colour' && (
            <ColourSelectOverlay
              seeds={colourSeeds}
              polygons={marquee?.kind === 'polygons' ? marquee.polygons : []}
              viewScale={view.scale}
            />
          )}
        </g>
      </svg>
      <TextEditor />
      <MarqueeToolbar />
      {tool === 'select-smart' && <SmartSelectStatusPanel />}
      {tool === 'select-colour' && <ColourSelectStatusPanel />}
      {tool === 'select-colour' && <ColourSelectParamsPanel />}
    </div>
  );
}
