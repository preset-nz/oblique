import { Eye, EyeOff, Loader2, Lock, LockOpen, Trash2, VenetianMask } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cookNodeFullRes } from '@/cook/cook';
import * as cache from '@/scene/cache';
import { useCacheVersionStore } from '@/scene/cache';
import { deleteNode } from '@/scene/deleteNode';
import { beginTransaction, endTransaction } from '@/scene/history';
import { useSceneStore } from '@/scene/store';
import type { BlendMode, SceneNode } from '@/scene/types';
import { isTextNode, isVectorNode } from '@/scene/types';
import { padlockAriaLabel, padlockClickIgnored, padlockVisualState } from './lockUi';

/**
 * Minimal layer list (03-compositor "Minimal layer list in the Stack tab").
 * One row per `scene.nodes` entry, rendered in array order — index 0 is the
 * TOP of the stack (compositor's bottom-up walk paints array-end-first;
 * see composite.ts), so the list reads Photoshop-style top-to-bottom.
 *
 * Reorder/visibility/opacity/blend all go through `setNodeProp`/`reorderNode`
 * — compositing-only mutations, no dirty flag, no recook (dirty rule 4).
 * Modifier editing stays in the debug StackPanel until Epic 04.
 */

const THUMB_SIZE = 40;

const BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'difference',
];

/**
 * Contain-fit rectangle for drawing a `srcW x srcH` bitmap into a
 * `box x box` square, centred. Pure — no canvas/DOM dependency, so it's
 * unit-testable under this repo's jsdom-less vitest setup.
 */
export function fitContain(
  srcW: number,
  srcH: number,
  box: number,
): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0 || box <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(box / srcW, box / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (box - w) / 2, y: (box - h) / 2, w, h };
}

/**
 * Target index for an up/down reorder nudge, or `null` if the row is
 * already at that edge (button should be disabled). Pure — mirrors the
 * debug panel's modifier reorder pattern (commit 32cb964).
 */
export function nudgeIndex(
  currentIndex: number,
  direction: 'up' | 'down',
  length: number,
): number | null {
  const target = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (target < 0 || target >= length) return null;
  return target;
}

/**
 * Label a rename commit should write, or `null` when the commit is a no-op
 * (rename-nodes.md). Empty/whitespace-only is a cancel, not a nameless layer;
 * an unchanged name skips the store write entirely so a stray double-click
 * leaves nothing on the undo stack. Pure — no DOM, no store.
 */
export function commitLabel(draft: string, current: string): string | null {
  const trimmed = draft.trim();
  if (trimmed === '' || trimmed === current) return null;
  return trimmed;
}

function Thumbnail({ node }: { node: SceneNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheVersion = useCacheVersionStore((s) => s.cacheVersion);

  // cacheVersion is a redraw trigger only (cache.get reads the module-scope
  // cache map, not React state) — it must stay in the deps array.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep, not read in the body
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    const bitmap = cache.get(node.id, 'draft');
    if (!bitmap) return;
    const { x, y, w, h } = fitContain(bitmap.width, bitmap.height, THUMB_SIZE);
    ctx.drawImage(bitmap, x, y, w, h);
  }, [node.id, cacheVersion]);

  return (
    <canvas
      ref={canvasRef}
      width={THUMB_SIZE}
      height={THUMB_SIZE}
      className="rounded bg-neutral-800 shrink-0"
    />
  );
}

function LayerRow({
  node,
  index,
  length,
  selected,
  onSelect,
}: {
  node: SceneNode;
  index: number;
  length: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const setNodeProp = useSceneStore((s) => s.setNodeProp);
  const reorderNode = useSceneStore((s) => s.reorderNode);
  const lockNode = useSceneStore((s) => s.lockNode);
  const unlockNode = useSceneStore((s) => s.unlockNode);
  const bakingNodeIds = useSceneStore((s) => s.bakingNodeIds);

  const up = nudgeIndex(index, 'up', length);
  const down = nudgeIndex(index, 'down', length);

  // Inline rename (rename-nodes.md). The in-progress string is transient —
  // local state, never scene state — so one setNodeProp call on commit is one
  // undo step per rename, not one per keystroke.
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const labelInputRef = useRef<HTMLInputElement>(null);
  // Both exits (Enter and Escape) unmount the input, and some browsers fire
  // blur on removal — this flag makes the resulting stray commit a no-op.
  // A duplicate identical write would be filtered by sceneDiff before it
  // reached history anyway; the flag keeps the one-undo-step-per-rename
  // guarantee from depending on that.
  const renameSettledRef = useRef(false);

  useEffect(() => {
    if (!editingLabel) return;
    labelInputRef.current?.focus();
    labelInputRef.current?.select(); // typing replaces the old name
  }, [editingLabel]);

  function startRename() {
    renameSettledRef.current = false;
    setLabelDraft(node.label);
    setEditingLabel(true);
  }

  function commitRename() {
    if (renameSettledRef.current) return;
    renameSettledRef.current = true;
    const next = commitLabel(labelDraft, node.label);
    if (next !== null) setNodeProp(node.id, { label: next });
    setEditingLabel(false);
  }

  function cancelRename() {
    renameSettledRef.current = true;
    setEditingLabel(false);
  }

  const padlockState = padlockVisualState(node, node.id, bakingNodeIds);

  function togglePadlock() {
    if (padlockClickIgnored(node.id, bakingNodeIds)) return; // in-flight bake — ignore further clicks
    if (padlockState === 'locked') {
      unlockNode(node.id);
      return;
    }
    lockNode(node.id, cookNodeFullRes).catch((err) => {
      // Same posture as export's own cook-failure surface (project/export.ts).
      toast.error('Lock failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Shared between the select-button and the rename-input variants of the row
  // lead, so entering edit mode doesn't make the thumbnail flicker out.
  const rowLead = (
    <>
      <Thumbnail node={node} />
      {/* Mask-span affordance (mask-span-scoping.md): a mask-output node
          clips everything below it since the previous mask node — this
          icon is the only thing that makes that span structure readable
          in the list. */}
      {node.output === 'mask' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <VenetianMask size={14} className="shrink-0 text-amber-400" aria-label="Mask node" />
          </TooltipTrigger>
          <TooltipContent>Mask — clips the span below it</TooltipContent>
        </Tooltip>
      )}
    </>
  );

  return (
    // The whole row selects (dogfood 2026-07-05: the label-only target kept
    // getting missed) — every inner control already stopPropagation()s its
    // own clicks. Keyboard access stays on the label <button> below, so the
    // div-level onClick is a pointer-only convenience, not the a11y path.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is the inner button
    // biome-ignore lint/a11y/noStaticElementInteractions: same — pointer-only convenience
    <div
      onClick={onSelect}
      className={`flex cursor-pointer items-center gap-2 rounded p-1 ${selected ? 'bg-neutral-800' : ''}`}
    >
      {editingLabel ? (
        <div className="flex flex-1 items-center gap-2 min-w-0">
          {rowLead}
          <input
            ref={labelInputRef}
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Escape/Enter belong to the input while it's open — the canvas
              // Escape handler must not also clear the node selection.
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
            aria-label="Layer name"
            className="min-w-0 flex-1 rounded bg-neutral-900 px-1 text-xs outline-none ring-1 ring-neutral-600"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          // Double-click is the discoverable rename gesture, F2 the keyboard
          // one (rename-nodes.md). Both live on the button rather than the
          // label <span> — a static element with a handler trips
          // a11y/noStaticElementInteractions, and the wider target matches the
          // whole-row-selects call from the 2026-07-05 dogfood.
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename();
          }}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              startRename();
            }
          }}
          className="flex flex-1 items-center gap-2 text-left min-w-0"
        >
          {rowLead}
          <span className="min-w-0 truncate flex-1 text-xs" title={node.label}>
            {node.label}
          </span>
        </button>
      )}
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          {(isVectorNode(node) || isTextNode(node)) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setNodeProp(node.id, {
                      output: node.output === 'mask' ? 'image' : 'mask',
                    });
                  }}
                  aria-label={node.output === 'mask' ? 'Use as image' : 'Use as mask'}
                  className={node.output === 'mask' ? 'text-amber-400' : 'text-neutral-500'}
                >
                  <VenetianMask size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {node.output === 'mask' ? 'Use as image' : 'Use as mask'}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setNodeProp(node.id, { visible: !node.visible });
                }}
                aria-label={node.visible ? 'Hide layer' : 'Show layer'}
              >
                {node.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{node.visible ? 'Hide layer' : 'Show layer'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={padlockState === 'baking'}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePadlock();
                }}
                aria-label={padlockAriaLabel(padlockState)}
                className={padlockState === 'locked' ? 'text-amber-400' : 'text-neutral-500'}
              >
                {padlockState === 'baking' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : padlockState === 'locked' ? (
                  <Lock size={14} />
                ) : (
                  <LockOpen size={14} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {padlockState === 'baking'
                ? 'Baking full quality…'
                : padlockState === 'locked'
                  ? 'Unlock layer'
                  : 'Lock layer — bakes full quality and freezes edits'}
            </TooltipContent>
          </Tooltip>
          <button
            type="button"
            disabled={up === null}
            aria-label="Move layer up"
            onClick={(e) => {
              e.stopPropagation();
              if (up !== null) reorderNode(node.id, up);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            disabled={down === null}
            aria-label="Move layer down"
            onClick={(e) => {
              e.stopPropagation();
              if (down !== null) reorderNode(node.id, down);
            }}
          >
            ↓
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Delete layer"
                className="ml-auto text-neutral-500 hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteNode(node.id);
                }}
              >
                <Trash2 size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Delete layer</TooltipContent>
          </Tooltip>
        </div>
        <Slider
          value={[Math.round(node.opacity * 100)]}
          min={0}
          max={100}
          step={1}
          onValueChange={(value) => setNodeProp(node.id, { opacity: value[0] / 100 })}
          // Undo/history transaction boundary (Epic 13): Radix's onValueChange
          // fires continuously while dragged; onPointerDown/onValueCommit are
          // this control's start/release, coalescing one drag into one step.
          onPointerDown={() => beginTransaction()}
          onValueCommit={() => endTransaction()}
          onClick={(e) => e.stopPropagation()}
        />
        {/* Dropdown, not a ToggleGroup: seven inline toggles made rows wider
            than the panel and forced horizontal scroll (dogfood 2026-07-04). */}
        <Select
          value={node.blendMode}
          onValueChange={(value) => {
            if (value) setNodeProp(node.id, { blendMode: value as BlendMode });
          }}
        >
          <SelectTrigger
            size="sm"
            className="h-6 w-fit text-xs"
            onClick={(e) => e.stopPropagation()}
            aria-label="Blend mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BLEND_MODES.map((mode) => (
              <SelectItem key={mode} value={mode} className="text-xs">
                {mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function LayerList({
  selectedNodeId,
  onSelectNode,
}: {
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}) {
  const nodes = useSceneStore((s) => s.scene.nodes);

  if (nodes.length === 0) return null;

  return (
    // data-layer-list: Viewport's Enter-to-edit-text shortcut recognises focus
    // here (text-tool-and-inspector.md) without importing across panels/canvas.
    <div className="flex flex-col gap-1" data-layer-list="">
      {nodes.map((node, index) => (
        <LayerRow
          key={node.id}
          node={node}
          index={index}
          length={nodes.length}
          selected={node.id === selectedNodeId}
          onSelect={() => onSelectNode(node.id)}
        />
      ))}
    </div>
  );
}
