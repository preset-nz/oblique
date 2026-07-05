import { InputNumber } from '@/components/InputNumber';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { docToScreen, useViewTransformStore } from '../viewTransform';
import { lassoBounds, type Rect } from './marqueeGeometry';
import type { MarqueeShape } from './marqueeState';
import { useMarqueeStateStore } from './marqueeState';

const TOOLBAR_OFFSET_PX = 8;

function boundsFor(marquee: MarqueeShape): Rect {
  return marquee.kind === 'lasso' ? lassoBounds(marquee.points) : marquee.rect;
}

/**
 * Floating panel near the active marquee (features/05-selection/
 * marquees.md): feather (px, document-space — scales with cook resolution
 * like any other spatial param, starter-ops.md), expand/contract, invert,
 * and a "mask from selection" action. The mask action's consumer
 * (`selection-to-mask.md`) isn't built yet, so the button stays disabled
 * with a tooltip — feather/expand/invert are stored here now so that story
 * has something to read once it lands.
 *
 * Positioned in screen space (`docToScreen`) near the marquee's document-
 * space bounds — this is DOM chrome, not marquee geometry, so it's the one
 * place in this story allowed its own screen-space maths (the "no per-
 * marquee screen-space re-derivation" rule is about the marquee shapes
 * themselves).
 */
export function MarqueeToolbar() {
  const marquee = useMarqueeStateStore((s) => s.marquee);
  const params = useMarqueeStateStore((s) => s.params);
  const setParams = useMarqueeStateStore((s) => s.setParams);
  const view = useViewTransformStore((s) => s.view);

  if (!marquee) return null;
  // An open (not-yet-closed) lasso has no finished shape to act on yet.
  if (marquee.kind === 'lasso' && !marquee.closed) return null;

  const bounds = boundsFor(marquee);
  const screen = docToScreen(view, { x: bounds.x + bounds.w, y: bounds.y });

  return (
    <div
      className="absolute z-10 flex flex-col gap-2 rounded border border-neutral-700 bg-neutral-900/95 p-2 text-neutral-200 shadow-lg"
      style={{ left: screen.x + TOOLBAR_OFFSET_PX, top: screen.y, minWidth: 180 }}
    >
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-neutral-400 tracking-wide">Feather</span>
        <div className="flex items-center gap-2">
          <Slider
            aria-label="Feather"
            value={[params.featherPx]}
            min={0}
            max={500}
            step={1}
            onValueChange={([v]) => setParams({ featherPx: v })}
            className="flex-1"
          />
          <InputNumber
            label=""
            value={params.featherPx}
            onChange={(v) => setParams({ featherPx: v })}
            min={0}
            max={500}
            step={1}
            className="w-16"
          />
        </div>
      </div>
      <InputNumber
        label="Expand"
        value={params.expand}
        min={-500}
        max={500}
        step={1}
        onChange={(v) => setParams({ expand: v })}
      />
      <label htmlFor="marquee-invert" className="flex items-center gap-2 text-xs">
        {/* border-neutral-500 override: the theme's dark `--input` border is
            15%-alpha white — invisible against this dark toolbar. Call-site
            fix only; the shared Checkbox wrapper waits for the colour pass. */}
        <Checkbox
          id="marquee-invert"
          className="border-neutral-500"
          checked={params.invert}
          onCheckedChange={(checked) => setParams({ invert: checked === true })}
        />
        Invert
      </label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled
            className="w-full rounded border border-dashed border-neutral-700 py-1 text-xs text-neutral-500 disabled:opacity-50"
          >
            Mask from selection
          </button>
        </TooltipTrigger>
        <TooltipContent>Coming soon — lands with selection-to-mask.md</TooltipContent>
      </Tooltip>
    </div>
  );
}
