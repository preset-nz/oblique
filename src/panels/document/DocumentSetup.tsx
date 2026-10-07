import { useEffect, useRef } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { filenameOf } from '@/project/import';
import { chooseBackgroundImageDialog } from '@/project/io';
import { useBackgroundSourceStore } from '@/scene/backgroundSource';
import { useSceneStore } from '@/scene/store';
import { beginTransaction, endTransaction } from '@/scene/transaction';
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

  // The native colour picker fires `input` continuously while dragged; coalesce
  // that into one undo step (same transaction pattern as the scrub inputs).
  // Blur isn't guaranteed (the popover can unmount the input first), so the
  // step also closes after a short idle and on unmount. Otherwise an open
  // transaction would swallow unrelated later edits into this one step.
  const colourDragging = useRef(false);
  const colourIdle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endColourStep = () => {
    clearTimeout(colourIdle.current);
    if (!colourDragging.current) return;
    colourDragging.current = false;
    endTransaction();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup; endColourStep reads refs
  useEffect(() => endColourStep, []);
  const backgroundMissing = useBackgroundSourceStore((s) => s.missing);

  // none/colour/image choice (background-colour.md's extension point,
  // filled by background-image.md). Choosing none or colour drops any held
  // image bitmap (store action); choosing image with none yet opens the
  // same file picker as Import.
  const backgroundKind = background?.type ?? 'none';
  const backgroundColor = background?.type === 'color' ? background.color : undefined;

  const applyBackgroundKind = (kind: string) => {
    if (kind === 'none') setBackgroundColor(null);
    else if (kind === 'color') setBackgroundColor(backgroundColor ?? DEFAULT_BACKGROUND_COLOR);
    else if (kind === 'image' && background?.type !== 'image') void chooseBackgroundImageDialog();
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
      <PopoverTrigger
        render={
          <button
            type="button"
            className="text-xs text-neutral-400 hover:text-neutral-100 whitespace-nowrap"
          />
        }
      >
        {sizeLabel}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="flex flex-col gap-3">
          <div className="text-xs font-medium text-neutral-300">Document setup</div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Aspect</span>
            <ToggleGroup
              value={presetId ? [presetId] : []}
              onValueChange={([value]) => value && applyPreset(value)}
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
              className="flex-wrap"
              value={baseId ? [baseId] : []}
              onValueChange={([value]) => value && applyBase(value)}
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
              value={[orientation]}
              onValueChange={([value]) => value && applyOrientation(value as Orientation)}
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
                value={[backgroundKind]}
                onValueChange={([value]) => value && applyBackgroundKind(value)}
              >
                <ToggleGroupItem value="none" aria-label="No background">
                  None
                </ToggleGroupItem>
                <ToggleGroupItem value="color" aria-label="Colour background">
                  Colour
                </ToggleGroupItem>
                <ToggleGroupItem value="image" aria-label="Image background">
                  Image
                </ToggleGroupItem>
              </ToggleGroup>
              {backgroundKind === 'color' && (
                <input
                  type="color"
                  value={backgroundColor ?? DEFAULT_BACKGROUND_COLOR}
                  onChange={(e) => {
                    if (!colourDragging.current) {
                      colourDragging.current = true;
                      beginTransaction();
                    }
                    setBackgroundColor(e.target.value);
                    clearTimeout(colourIdle.current);
                    colourIdle.current = setTimeout(endColourStep, 600);
                  }}
                  onBlur={endColourStep}
                  className="h-6 w-8 cursor-pointer rounded border border-neutral-700 bg-transparent"
                  aria-label="Background colour"
                />
              )}
            </div>
            {background?.type === 'image' && (
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={
                    backgroundMissing ? 'truncate text-amber-500' : 'truncate text-neutral-400'
                  }
                  title={background.sourcePath}
                >
                  {backgroundMissing
                    ? `${filenameOf(background.sourcePath)} (file not found)`
                    : filenameOf(background.sourcePath)}
                </span>
                <button
                  type="button"
                  className="whitespace-nowrap text-neutral-400 hover:text-neutral-100"
                  onClick={() => void chooseBackgroundImageDialog()}
                >
                  Choose image…
                </button>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
