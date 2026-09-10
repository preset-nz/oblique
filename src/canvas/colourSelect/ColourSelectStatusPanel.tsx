import { useColourSelectStore } from './state';

/**
 * `select-colour`'s status chrome (colour-range-select.md) — same posture
 * as `SmartSelectStatusPanel`, minus the "downloading" state (no model, no
 * weights, nothing to download). Renders nothing at `'idle'`.
 */
export function ColourSelectStatusPanel() {
  const status = useColourSelectStore((s) => s.status);
  const error = useColourSelectStore((s) => s.error);

  if (status === 'idle') return null;

  const message = status === 'pending' ? 'Selecting…' : (error ?? 'Colour select failed');

  return (
    <div
      className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded border border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-200 shadow-lg"
      role="status"
    >
      {message}
    </div>
  );
}
