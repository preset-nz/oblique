import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSceneStore } from '@/scene/store';
import {
  ASPECT_PRESETS,
  BASE_PRESETS,
  computeDocumentSize,
  describeDocumentSize,
  describeLongEdge,
  nextDocumentSize,
  type Orientation,
} from './aspect';

/**
 * Document setup — aspect preset + orientation. Applies to empty documents
 * and post-hoc: sets `scene.documentSize` only (`setDocumentSize` is
 * compositing-only, no dirty flag — dirty rule 4 in scene/store.ts), so
 * picking a preset recomposites without recooking any node.
 */
const DEFAULT_BACKGROUND_COLOR = '#ffffff';

export function DocumentSetup() {
  const documentSize = useSceneStore((s) => s.scene.documentSize);
  const setDocumentSize = useSceneStore((s) => s.setDocumentSize);
  const background = useSceneStore((s) => s.scene.background);
  const setBackgroundColor = useSceneStore((s) => s.setBackgroundColor);
  const { presetId, orientation } = describeDocumentSize(documentSize);
  const baseId = describeLongEdge(documentSize);

  // none/colour/(image, later) choice — background-colour.md's extension
  // point for background-image.md, which adds an 'image' option here
  // without reworking this control.
  const backgroundKind = background?.type ?? 'none';

  const applyBackgroundKind = (kind: string) => {
    if (kind === 'none') setBackgroundColor(null);
    else if (kind === 'color') setBackgroundColor(background?.color ?? DEFAULT_BACKGROUND_COLOR);
  };

  const applyPreset = (nextPresetId: string) => {
    const preset = ASPECT_PRESETS.find((p) => p.id === nextPresetId);
    if (!preset) return;
    setDocumentSize(nextDocumentSize(documentSize, preset, orientation));
  };

  const applyBase = (nextBaseId: string) => {
    const base = BASE_PRESETS.find((b) => b.id === nextBaseId);
    if (!base) return;
    const preset = ASPECT_PRESETS.find((p) => p.id === presetId) ?? ASPECT_PRESETS[0];
    setDocumentSize(computeDocumentSize(base.longEdge, preset.ratio, orientation));
  };

  const applyOrientation = (nextOrientation: Orientation) => {
    const preset = ASPECT_PRESETS.find((p) => p.id === presetId) ?? ASPECT_PRESETS[0];
    setDocumentSize(nextDocumentSize(documentSize, preset, nextOrientation));
  };

  const [w, h] = documentSize;
  const sizeLabel = w > 0 && h > 0 ? `${w} × ${h}` : 'no document';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-xs text-neutral-400 hover:text-neutral-100 whitespace-nowrap"
        >
          {sizeLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="flex flex-col gap-3">
          <div className="text-xs font-medium text-neutral-300">Document setup</div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Aspect</span>
            <ToggleGroup
              type="single"
              value={presetId ?? undefined}
              onValueChange={(value) => value && applyPreset(value)}
            >
              {ASPECT_PRESETS.map((preset) => (
                <ToggleGroupItem key={preset.id} value={preset.id} aria-label={preset.label}>
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Base (longest side)</span>
            <ToggleGroup
              type="single"
              className="flex-wrap"
              value={baseId ?? undefined}
              onValueChange={(value) => value && applyBase(value)}
            >
              {BASE_PRESETS.map((base) => (
                <ToggleGroupItem key={base.id} value={base.id} aria-label={base.label}>
                  {base.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Orientation</span>
            <ToggleGroup
              type="single"
              value={orientation}
              onValueChange={(value) => value && applyOrientation(value as Orientation)}
            >
              <ToggleGroupItem value="landscape" aria-label="Landscape">
                Landscape
              </ToggleGroupItem>
              <ToggleGroupItem value="portrait" aria-label="Portrait">
                Portrait
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Background</span>
            <div className="flex items-center gap-2">
              <ToggleGroup
                type="single"
                value={backgroundKind}
                onValueChange={(value) => value && applyBackgroundKind(value)}
              >
                <ToggleGroupItem value="none" aria-label="No background">
                  None
                </ToggleGroupItem>
                <ToggleGroupItem value="color" aria-label="Colour background">
                  Colour
                </ToggleGroupItem>
              </ToggleGroup>
              {backgroundKind === 'color' && (
                <input
                  type="color"
                  value={background?.color ?? DEFAULT_BACKGROUND_COLOR}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  className="h-6 w-8 cursor-pointer rounded border border-neutral-700 bg-transparent"
                  aria-label="Background colour"
                />
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
