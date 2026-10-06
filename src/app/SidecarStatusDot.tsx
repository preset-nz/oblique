import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidecarStatusStore } from '@/sidecar/client';
// Side-effecting import: wires up the app-wide sidecar client singleton
// (transport listeners + initial ping) the first time this module loads.
// Safe to import more than once — it's a singleton.
import '@/sidecar/singleton';

/** Small green/red dot reflecting sidecar connectivity, with a tooltip for the last error. */
export function SidecarStatusDot() {
  const status = useSidecarStatusStore((state) => state.status);
  const lastError = useSidecarStatusStore((state) => state.lastError);

  const up = status === 'up';
  const tooltipText = up ? 'Ops engine connected' : (lastError ?? 'Ops engine disconnected');

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-1.5 text-xs text-neutral-400" />}
      >
        <span
          className={`h-2 w-2 rounded-full ${up ? 'bg-green-500' : 'bg-red-500'}`}
          aria-hidden="true"
        />
        {up ? 'Connected' : 'Disconnected'}
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
