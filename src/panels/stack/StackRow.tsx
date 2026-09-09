import { PropertyPanel } from '@preset.nz/property-editors';
import {
  Blend,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  MoreVertical,
  RotateCcw,
  Spline,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { InputNumber } from '@/components/InputNumber';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { beginTransaction, endTransaction } from '@/scene/history';
import { isMaskableMarquee, useMarqueeStateStore } from '@/scene/marquee';
import { useSceneStore } from '@/scene/store';
import { isVectorNode, type Modifier, type SceneNode } from '@/scene/types';
import type { OpDescriptor } from '@/sidecar/opsCache';
import { opLabel } from '@/sidecar/opsCache';
import { LOCKED_HINT, stackControlsDisabled } from './lockUi';
import { modifierScopeKey } from './modifierScope';
import { useRowCollapseStore } from './rowCollapse';
import { nudgeModelIndex } from './stackOrder';

interface StackRowProps {
  node: SceneNode;
  modifier: Modifier;
  /** This row's index in the DISPLAYED (bottom-to-top) list, not the scene-model array. */
  displayIndex: number;
  /** Total row count — same in both orderings. */
  length: number;
  ops: OpDescriptor[];
}

/**
 * One modifier row: reorder nudge (drag handle icon, up/down — see the
 * story's fallback note: pointer-drag DnD is out of this story's budget,
 * so the reorder control reuses `LayerList`'s up/down nudge pattern),
 * enabled toggle, label, expand chevron, overflow (duplicate/delete/reset).
 * The expanded region mounts `<PropertyPanel>` scoped to this modifier.
 */
export function StackRow({ node, modifier, displayIndex, length, ops }: StackRowProps) {
  const setModifierEnabled = useSceneStore((s) => s.setModifierEnabled);
  const reorderModifier = useSceneStore((s) => s.reorderModifier);
  const removeModifier = useSceneStore((s) => s.removeModifier);
  const addModifier = useSceneStore((s) => s.addModifier);
  const setModifierParam = useSceneStore((s) => s.setModifierParam);
  const applyMarqueeAsVectorMask = useSceneStore((s) => s.applyMarqueeAsVectorMask);
  const setModifierVectorMask = useSceneStore((s) => s.setModifierVectorMask);
  const removeModifierMask = useSceneStore((s) => s.removeModifierMask);
  // Select the stable nodes array and filter during render — a selector
  // returning a fresh array per call trips React 19's getSnapshot-must-be-
  // cached invariant and loops forever.
  const sceneNodes = useSceneStore((s) => s.scene.nodes);
  const vectorNodes = sceneNodes.filter(isVectorNode);
  // Which kind of mask (if any) this modifier's maskId resolves to
  // (vector-modifier-masks.md's resolution rule: masks table first, then
  // maskRefs) — drives the Blend indicator's tooltip wording.
  const maskKind = useSceneStore((s) => {
    if (!modifier.maskId) return undefined;
    if (s.scene.masks?.[modifier.maskId]) return 'selection';
    if (s.scene.maskRefs?.[modifier.maskId]) return 'vector';
    return undefined;
  });
  const marquee = useMarqueeStateStore((s) => s.marquee);
  const maskParams = useMarqueeStateStore((s) => s.params);
  const setMaskParams = useMarqueeStateStore((s) => s.setParams);
  const rowExpanded = useRowCollapseStore((s) => s.isExpanded(modifier.id));
  const toggleExpanded = useRowCollapseStore((s) => s.toggle);
  const [vectorPickerOpen, setVectorPickerOpen] = useState(false);

  const descriptor = ops.find((o) => o.name === modifier.type);
  // Param-less ops (e.g. invert) have nothing to expand. An UNKNOWN op stays
  // expandable so the PropertyPanel empty state can explain itself.
  const expandable = !descriptor || descriptor.params.length > 0;
  const expanded = expandable && rowExpanded;
  const up = nudgeModelIndex(displayIndex, 'up', length);
  const down = nudgeModelIndex(displayIndex, 'down', length);
  // Locked node selected (lock-ui.md): every cook-dirtying control on this
  // row goes inert — reorder, enable toggle, mask apply, duplicate/reset/
  // delete, and the expanded PropertyPanel's own fields (via `readOnly`
  // below). The row still expands/collapses to inspect params read-only.
  const locked = stackControlsDisabled(node);

  function resetParams() {
    if (!descriptor || locked) return;
    for (const spec of descriptor.params) {
      setModifierParam(node.id, modifier.id, spec.name, spec.default as number | string | boolean);
    }
  }

  function duplicate() {
    if (locked) return;
    const modId = addModifier(node.id, modifier.type, { ...modifier.params });
    useRowCollapseStore.getState().expand(modId);
  }

  /**
   * "Mask from selection" (marquees-as-vectors.md): converts the active
   * marquee into a hidden `VectorNode` + a live `VectorMaskRef`, not a baked
   * `MaskDef` — the mask is document-pinned and editable forever with the
   * pen tool (the story's whole point). One undo step: node creation +
   * attach + replace-cleanup all land inside this transaction.
   */
  function maskFromSelection() {
    if (locked) return;
    const state = useMarqueeStateStore.getState();
    const active = state.marquee;
    if (!isMaskableMarquee(active) || !active) return;
    beginTransaction();
    applyMarqueeAsVectorMask(node.id, modifier.id, active, state.params);
    endTransaction();
    // Consumed — same "no orphaned overlay state" rule as every other
    // marquee exit.
    state.clear();
  }

  /**
   * Attach a *live* vector reference (vector-modifier-masks.md): the
   * feather/expand/invert come from the marquee-params store, which the
   * picker popover now exposes directly (dogfood 2026-07-06 — the
   * MarqueeToolbar only shows with an active marquee, so the vector flow
   * had no way to reach these). No transform snapshot: vector masks are
   * document-pinned (VectorMaskRef's doc comment) — the cook path reads
   * the consumer's current transform2d fresh every cook.
   */
  function maskFromVectorNode(vectorNodeId: string) {
    if (locked) return;
    const params = useMarqueeStateStore.getState().params;
    setModifierVectorMask(node.id, modifier.id, vectorNodeId, {
      featherPx: params.featherPx,
      expand: params.expand,
      invert: params.invert,
    });
    setVectorPickerOpen(false);
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40">
      <div
        className={`flex items-center gap-1.5 px-1.5 py-1 ${modifier.enabled ? '' : 'opacity-40'}`}
      >
        <div className="flex flex-col text-neutral-500">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={up === null || locked}
                aria-label="Move modifier up (applies later)"
                className="leading-none disabled:opacity-30"
                onClick={() => up !== null && !locked && reorderModifier(node.id, modifier.id, up)}
              >
                ▲
              </button>
            </TooltipTrigger>
            <TooltipContent>{locked ? LOCKED_HINT : 'Applies later'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={down === null || locked}
                aria-label="Move modifier down (applies earlier)"
                className="leading-none disabled:opacity-30"
                onClick={() =>
                  down !== null && !locked && reorderModifier(node.id, modifier.id, down)
                }
              >
                ▼
              </button>
            </TooltipTrigger>
            <TooltipContent>{locked ? LOCKED_HINT : 'Applies earlier'}</TooltipContent>
          </Tooltip>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={locked}
              className="disabled:opacity-30"
              aria-label={modifier.enabled ? 'Disable modifier' : 'Enable modifier'}
              onClick={() => setModifierEnabled(node.id, modifier.id, !modifier.enabled)}
            >
              {modifier.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {locked ? LOCKED_HINT : modifier.enabled ? 'Disable' : 'Enable'}
          </TooltipContent>
        </Tooltip>

        <button
          type="button"
          className="flex flex-1 items-center gap-1 truncate text-left text-xs"
          onClick={() => expandable && toggleExpanded(modifier.id)}
          aria-expanded={expandable ? expanded : undefined}
        >
          {expandable ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            // Spacer keeps param-less rows' labels aligned with expandable ones.
            <span className="w-3.5 shrink-0" />
          )}
          <span className="truncate">{descriptor ? opLabel(descriptor) : modifier.type}</span>
          {modifier.maskId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Blend size={12} className="shrink-0 text-neutral-500" aria-label="Masked" />
              </TooltipTrigger>
              <TooltipContent>
                {maskKind === 'vector'
                  ? 'Masked — live vector reference; editing the shape recooks this modifier'
                  : 'Masked — this modifier affects only its region'}
              </TooltipContent>
            </Tooltip>
          )}
        </button>

        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button type="button" aria-label="Modifier options" className="text-neutral-500">
                  <MoreVertical size={14} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Options</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-40 p-1">
            <button
              type="button"
              disabled={locked}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={duplicate}
            >
              <Copy size={12} /> Duplicate
            </button>
            <button
              type="button"
              disabled={locked}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={resetParams}
            >
              <RotateCcw size={12} /> Reset params
            </button>
            <button
              type="button"
              disabled={locked || !isMaskableMarquee(marquee)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={maskFromSelection}
            >
              <Blend size={12} />{' '}
              {modifier.maskId ? 'Replace mask from selection' : 'Mask from selection'}
            </button>
            <button
              type="button"
              disabled={locked || vectorNodes.length === 0}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={() => !locked && setVectorPickerOpen((open) => !open)}
            >
              <Spline size={12} />{' '}
              {modifier.maskId ? 'Replace mask from vector node' : 'Mask from vector node'}
            </button>
            {vectorPickerOpen && !locked && (
              <div className="ml-4 flex flex-col gap-1 border-l border-neutral-800 pl-2">
                {/* Same tuning params the marquee flow uses (shared store),
                    surfaced here because MarqueeToolbar only renders with an
                    active marquee — the vector flow otherwise had no way to
                    set feather/expand/invert (dogfood 2026-07-06). Applied
                    per-reference at pick time. */}
                <InputNumber
                  label="Feather"
                  value={maskParams.featherPx}
                  min={0}
                  max={500}
                  step={1}
                  onChange={(v) => setMaskParams({ featherPx: v })}
                />
                <InputNumber
                  label="Expand"
                  value={maskParams.expand}
                  min={-500}
                  max={500}
                  step={1}
                  onChange={(v) => setMaskParams({ expand: v })}
                />
                <label
                  htmlFor={`vector-mask-invert-${modifier.id}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <Checkbox
                    id={`vector-mask-invert-${modifier.id}`}
                    className="border-neutral-500"
                    checked={maskParams.invert}
                    onCheckedChange={(checked) => setMaskParams({ invert: checked === true })}
                  />
                  Invert
                </label>
                {vectorNodes.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="truncate rounded px-2 py-1 text-left text-xs hover:bg-neutral-800"
                    onClick={() => maskFromVectorNode(v.id)}
                  >
                    <Spline size={12} className="mr-1 inline" />
                    {v.label}
                  </button>
                ))}
              </div>
            )}
            {modifier.maskId && (
              <button
                type="button"
                disabled={locked}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={() => !locked && removeModifierMask(node.id, modifier.id)}
              >
                <Blend size={12} className="opacity-40" /> Remove mask
              </button>
            )}
            <button
              type="button"
              disabled={locked}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-red-400 hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
              onClick={() => !locked && removeModifier(node.id, modifier.id)}
            >
              <Trash2 size={12} /> Delete
            </button>
          </PopoverContent>
        </Popover>
      </div>

      {expanded && (
        <div className="border-t border-neutral-800">
          <PropertyPanel
            scopeKey={modifierScopeKey(modifier.type)}
            selection={{ nodeId: node.id, modId: modifier.id }}
            ctx={null}
            readOnly={locked}
            emptyState={
              <div className="px-3 py-2 text-xs text-neutral-500">
                Unknown op "{modifier.type}" — sidecar hasn't reported its params yet.
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}
