/**
 * `select_colour` over the sidecar frame protocol (Epic 17 story 2b —
 * `guidance/projects/oblique/features/17-ml-masking-and-fill/
 * colour-range-select.md`). The magic wand: no model, no weights, no
 * backend — pure NumPy in the sidecar (`ml/colour.py`), so unlike
 * `sidecarSegment.ts` this is a plain function, not an `AiAdapter` driver.
 * There is nothing to swap (always the sidecar) and nothing to disable on
 * capability grounds (only on the sidecar being down, same as `cook`) — the
 * adapter's swappable-backend/capability machinery doesn't apply here, so
 * this deliberately doesn't implement `AiAdapter`.
 *
 * Request/response shape mirrors `segment`'s (same frame, same response
 * fields) with one deviation from the story doc's own JSON sketch, per the
 * orchestrator's override: the request carries a `seeds` ARRAY (`{x, y,
 * label}`), not a single `seed` — positive-label seeds OR-ed, negative
 * subtracted, one deterministic request instead of N client-issued ones.
 * See `sidecar/handlers/select_colour.py`'s own docstring for exactly how
 * they're combined.
 */
export type ColourSpace = 'lab' | 'rgb';

export interface ColourSeed {
  x: number;
  y: number;
  /** 1 = positive (include), 0 = negative (exclude) — same convention as `segment`'s point prompt. */
  label: 0 | 1;
}

export interface ColourSelectParams {
  tolerance: number;
  contiguous: boolean;
  space: ColourSpace;
  expand: number;
  minIsland: number;
}

export const DEFAULT_COLOUR_SELECT_PARAMS: ColourSelectParams = {
  tolerance: 32,
  contiguous: true,
  space: 'lab',
  expand: 0,
  minIsland: 16,
};

export interface SelectColourOptions {
  /** RGBA8, `width * height * 4` bytes — the target node's cooked buffer, same convention as `segment`. */
  image: Uint8Array;
  width: number;
  height: number;
  seeds: ColourSeed[];
  params: ColourSelectParams;
}

export interface SelectColourResult {
  /** Single-channel u8 mask, `width * height` bytes, same buffer pixel space as the request. */
  mask: Uint8Array;
  /** Closed contours (holes KEPT — `trace_mask(..., keep_holes=True)`), in the request's buffer pixel space. */
  polygons: Array<Array<{ x: number; y: number }>>;
}

/** Transport edge injected for tests, same pattern as `sidecarSegment.ts`'s `SidecarSegmentDeps`. */
export interface SidecarSelectColourDeps {
  request: (
    header: Record<string, unknown>,
    payload: Uint8Array,
  ) => Promise<{ header: Record<string, unknown>; payload: Uint8Array }>;
}

async function productionRequest(
  header: Record<string, unknown>,
  payload: Uint8Array,
): Promise<{ header: Record<string, unknown>; payload: Uint8Array }> {
  // Dynamic import: same "singleton starts the real Tauri transport as a
  // side effect of being imported" deferral `sidecarSegment.ts`/`cook.ts`
  // use, so importing this module with injected deps never pulls in Tauri
  // IPC.
  const { sidecarClient } = await import('@/sidecar/singleton');
  return sidecarClient.request(header, payload);
}

export const productionSidecarSelectColourDeps: SidecarSelectColourDeps = {
  request: productionRequest,
};

function isPointArray(value: unknown): value is Array<{ x: number; y: number }> {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        p !== null &&
        typeof p === 'object' &&
        typeof (p as { x?: unknown }).x === 'number' &&
        typeof (p as { y?: unknown }).y === 'number',
    )
  );
}

/** `header.polygons` -> `SelectColourResult['polygons']`, tolerant of a missing/malformed field. */
function parsePolygons(value: unknown): Array<Array<{ x: number; y: number }>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isPointArray);
}

/** `select_colour` over the sidecar frame protocol. */
export async function selectColour(
  options: SelectColourOptions,
  deps: SidecarSelectColourDeps = productionSidecarSelectColourDeps,
): Promise<SelectColourResult> {
  const header = {
    op: 'select_colour',
    width: options.width,
    height: options.height,
    seeds: options.seeds,
    params: {
      tolerance: options.params.tolerance,
      contiguous: options.params.contiguous,
      space: options.params.space,
      expand: options.params.expand,
      min_island: options.params.minIsland,
    },
  };

  const { header: responseHeader, payload } = await deps.request(header, options.image);

  return {
    mask: payload,
    polygons: parsePolygons(responseHeader.polygons),
  };
}
