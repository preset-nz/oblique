import { Eye, EyeOff, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import * as cache from '@/scene/cache';
import { useCacheVersionStore } from '@/scene/cache';
import { deleteNode } from '@/scene/deleteNode';
import { beginTransaction, endTransaction } from '@/scene/history';
import { useSceneStore } from '@/scene/store';
import type { BlendMode, SceneNode } from '@/scene/types';

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

  const up = nudgeIndex(index, 'up', length);
  const down = nudgeIndex(index, 'down', length);

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
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-1 items-center gap-2 text-left min-w-0"
      >
        <Thumbnail node={node} />
        <span className="min-w-0 truncate flex-1 text-xs" title={node.label}>
          {node.label}
        </span>
      </button>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
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
    <div className="flex flex-col gap-1">
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
