import { Minus, Plus } from 'lucide-react';
import { SidecarStatusDot } from '@/app/SidecarStatusDot';
import { useViewTransformStore } from '@/canvas/viewTransform';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { filenameOf } from '@/project/import';
import { useProjectMetaStore } from '@/project/io';

const ZOOM_BUTTON_CLASS =
  'inline-flex h-4 items-center justify-center rounded px-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100';

/** Icon-sized ghost button with a tooltip; `label` doubles as the aria-label minus the shortcut. */
function ZoomButton(props: {
  label: string;
  shortcut: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={props.label}
          className={props.className ?? ZOOM_BUTTON_CLASS}
          onClick={props.onClick}
        >
          {props.children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{`${props.label} (${props.shortcut})`}</TooltipContent>
    </Tooltip>
  );
}

export function StatusBar() {
  const scale = useViewTransformStore((state) => state.view.scale);
  const cursorDoc = useViewTransformStore((state) => state.cursorDoc);
  const projectPath = useProjectMetaStore((state) => state.path);
  const dirtySinceSave = useProjectMetaStore((state) => state.dirtySinceSave);
  const projectName = projectPath ? filenameOf(projectPath) : 'untitled';

  const { zoomIn, zoomOut, fitToWindow } = useViewTransformStore.getState();
  const zoomPercent = Math.round(scale * 100);

  const cursorText =
    cursorDoc === null ? '—' : `${Math.round(cursorDoc.x)}, ${Math.round(cursorDoc.y)}`;

  const Separator = () => <div className="h-4 w-px bg-neutral-800" />;

  return (
    <div
      data-testid="status-bar"
      className="h-6 border-t border-neutral-800 bg-neutral-900 text-xs flex items-center px-3 gap-3"
    >
      {/* Tool placeholder */}
      <div className="flex items-center gap-1 whitespace-nowrap">
        <span className="text-neutral-500">—</span>
      </div>

      <Separator />

      {/* Zoom level */}
      <div className="flex items-center gap-0.5 whitespace-nowrap">
        <ZoomButton label="Zoom Out" shortcut="⌘−" onClick={zoomOut}>
          <Minus size={12} aria-hidden="true" />
        </ZoomButton>
        <ZoomButton
          label="Fit in Window"
          shortcut="⌘0"
          onClick={fitToWindow}
          className={`${ZOOM_BUTTON_CLASS} min-w-9 tabular-nums`}
        >
          {zoomPercent}%
        </ZoomButton>
        <ZoomButton label="Zoom In" shortcut="⌘=" onClick={zoomIn}>
          <Plus size={12} aria-hidden="true" />
        </ZoomButton>
      </div>

      <Separator />

      {/* Cursor position */}
      <div className="flex items-center gap-1 whitespace-nowrap">
        <span>{cursorText}</span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Save status: project filename, dot while unsaved changes exist */}
      <div className="flex items-center gap-1 whitespace-nowrap" aria-live="polite">
        <span className="text-neutral-500">
          {projectName}
          {dirtySinceSave ? ' •' : ''}
        </span>
      </div>

      <Separator />

      {/* Sidecar health */}
      <div className="flex items-center gap-1">
        <SidecarStatusDot />
      </div>
    </div>
  );
}
