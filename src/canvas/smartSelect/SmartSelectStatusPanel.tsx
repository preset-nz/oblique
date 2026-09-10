import { useSmartSelectStore } from './state';

/**
 * `select-smart`'s status chrome (segment-to-vector.md's fixed client
 * contract): "Show an indeterminate 'Downloading model… (first use, ~40 MB)'
 * state while a request is pending longer than ~1s; a generic pending state
 * otherwise." Screen-space DOM, not document-space SVG — same posture as
 * `marquees/MarqueeToolbar.tsx`, the existing precedent for this kind of
 * floating chrome sitting beside the canvas rather than inside its overlay
 * group. Renders nothing at `'idle'` — no chrome for a tool sitting quietly
 * waiting for a click.
 */
export function SmartSelectStatusPanel() {
  const status = useSmartSelectStore((s) => s.status);
  const error = useSmartSelectStore((s) => s.error);

  if (status === 'idle') return null;

  const message =
    status === 'downloading'
      ? 'Downloading model… (first use, ~40 MB)'
      : status === 'pending'
        ? 'Segmenting…'
        : (error ?? 'Segment failed');

  return (
    <div
      className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded border border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-200 shadow-lg"
      role="status"
    >
      {message}
    </div>
  );
}
