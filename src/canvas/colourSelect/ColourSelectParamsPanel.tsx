import type { ColourSpace } from '@/ai/sidecarSelectColour';
import { InputNumber } from '@/components/InputNumber';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { useColourSelectStore } from './state';

/**
 * `select-colour`'s own request-params panel (colour-range-select.md):
 * tolerance, contiguous, colour space, expand, min island — these feed the
 * SIDECAR's `ml/colour.py` algorithm (buffer-pixel-space box dilate/erode
 * BEFORE tracing), which is a different knob from `MarqueeToolbar`'s own
 * "Expand" (a document-space offset of the already-traced vector mask,
 * applied AFTER commit, editable forever on the stack row) — hence
 * "Expand (pre-select)" below, so the two never read as duplicates when
 * both panels are on screen at once (this one + `MarqueeToolbar`, which
 * renders unconditionally for any active marquee including this tool's own
 * `polygons` preview).
 *
 * Screen-space DOM chrome, not document-space SVG — same posture as
 * `SmartSelectStatusPanel`. Positioned as a fixed top-left panel (not
 * bounds-relative like `MarqueeToolbar`): unlike a marquee shape, this
 * panel is live from tool activation (params exist before any seed does),
 * so there is no shape to anchor it to yet on first render.
 */
export function ColourSelectParamsPanel() {
  const params = useColourSelectStore((s) => s.params);
  const setParams = useColourSelectStore((s) => s.setParams);

  return (
    <div className="absolute top-2 left-2 z-10 flex w-48 flex-col gap-2 rounded border border-neutral-700 bg-neutral-900/95 p-2 text-neutral-200 shadow-lg">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-neutral-400 tracking-wide">Tolerance</span>
        <div className="flex items-center gap-2">
          <Slider
            aria-label="Tolerance"
            value={[params.tolerance]}
            min={0}
            max={255}
            step={1}
            onValueChange={([v]) => setParams({ tolerance: v })}
            className="flex-1"
          />
          <InputNumber
            label=""
            value={params.tolerance}
            onChange={(v) => setParams({ tolerance: v })}
            min={0}
            max={255}
            step={1}
            className="w-14"
          />
        </div>
      </div>

      <label htmlFor="colour-select-contiguous" className="flex items-center gap-2 text-xs">
        {/* border-neutral-500 override: same fix MarqueeToolbar's own Checkbox needs against this dark panel. */}
        <Checkbox
          id="colour-select-contiguous"
          className="border-neutral-500"
          checked={params.contiguous}
          onCheckedChange={(checked) => setParams({ contiguous: checked === true })}
        />
        Contiguous
      </label>

      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-neutral-400">Colour space</span>
        <Select
          value={params.space}
          onValueChange={(value) => {
            if (value) setParams({ space: value as ColourSpace });
          }}
        >
          <SelectTrigger size="sm" className="h-6 w-fit text-xs" aria-label="Colour space">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lab" className="text-xs">
              Lab
            </SelectItem>
            <SelectItem value="rgb" className="text-xs">
              RGB
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <InputNumber
        label="Expand (pre-select)"
        value={params.expand}
        min={-20}
        max={20}
        step={1}
        onChange={(v) => setParams({ expand: v })}
      />

      <InputNumber
        label="Min island"
        value={params.minIsland}
        min={0}
        max={10000}
        step={1}
        onChange={(v) => setParams({ minIsland: v })}
      />
    </div>
  );
}
