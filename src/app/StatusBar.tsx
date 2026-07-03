import { SidecarStatusDot } from '@/app/SidecarStatusDot';
import { useViewTransformStore } from '@/canvas/viewTransform';

export function StatusBar() {
  const scale = useViewTransformStore((state) => state.view.scale);
  const cursorDoc = useViewTransformStore((state) => state.cursorDoc);

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
      <div className="flex items-center gap-1 whitespace-nowrap">
        <span>{zoomPercent}%</span>
      </div>

      <Separator />

      {/* Cursor position */}
      <div className="flex items-center gap-1 whitespace-nowrap">
        <span>{cursorText}</span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Save status placeholder */}
      <div className="flex items-center gap-1 whitespace-nowrap" aria-live="polite">
        <span className="text-neutral-500">—</span>
      </div>

      <Separator />

      {/* Sidecar health */}
      <div className="flex items-center gap-1">
        <SidecarStatusDot />
      </div>
    </div>
  );
}
