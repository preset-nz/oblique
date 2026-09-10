import type { SelectColourOptions, SelectColourResult } from '@/ai/sidecarSelectColour';
import { selectColour } from '@/ai/sidecarSelectColour';
import type { MarqueeShape } from '@/scene/marquee';
import { useMarqueeStateStore } from '@/scene/marquee';
import { bufferPolygonsToDoc, docPointsToBuffer } from '../selectShared/coords';
import { getTargetPayload, type TargetPayload } from '../selectShared/payload';
import { hasSeeds, useColourSelectStore } from './state';

const DEBOUNCE_MS = 150;

export interface ColourSelectControllerDeps {
  getPayload: (nodeId: string) => TargetPayload | undefined;
  selectColour: (options: SelectColourOptions) => Promise<SelectColourResult>;
  setMarquee: (marquee: MarqueeShape | null) => void;
}

export const productionColourSelectControllerDeps: ColourSelectControllerDeps = {
  getPayload: getTargetPayload,
  selectColour: (options) => selectColour(options),
  setMarquee: (marquee) => useMarqueeStateStore.getState().setMarquee(marquee),
};

/**
 * Debounces the `select-colour` tool's seeds/params into sidecar
 * `select_colour` requests (colour-range-select.md) — same shape as
 * `smartSelect/controller.ts`'s `SmartSelectController`, minus the
 * download-progress heuristic (no model, nothing to download). Every
 * seeds/params edit re-arms a 150ms debounce; a generation counter drops
 * any response superseded by a newer edit before it lands.
 *
 * A class, same reasoning as `SmartSelectController`: tests spin up
 * independent instances with mock deps and fake timers.
 */
export class ColourSelectController {
  private readonly deps: ColourSelectControllerDeps;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private unsubscribe?: () => void;
  private unsubscribeMarquee?: () => void;
  /** Same "own write, not an external commit" guard `SmartSelectController` documents for its own `suppressNextMarqueeNullClear`. */
  private suppressNextMarqueeNullClear = false;

  constructor(deps: ColourSelectControllerDeps = productionColourSelectControllerDeps) {
    this.deps = deps;
  }

  start(): void {
    this.unsubscribe = useColourSelectStore.subscribe((state, prev) => {
      if (!state.targetNodeId) return;
      const changed = state.seeds !== prev.seeds || state.params !== prev.params;
      if (!changed) return;
      this.armDebounce();
    });

    // Same rationale as `SmartSelectController`'s own marquee subscription:
    // StackRow's "Mask from selection" commit clears the MARQUEE store, not
    // this one — without reacting to that, seed markers would keep
    // painting after commit. Gated to a `polygons` marquee this tool's own
    // debounce wrote (not any other tool's outline-consumption clear).
    this.unsubscribeMarquee = useMarqueeStateStore.subscribe((state, prev) => {
      if (state.marquee !== null || prev.marquee?.kind !== 'polygons') return;
      if (this.suppressNextMarqueeNullClear) {
        this.suppressNextMarqueeNullClear = false;
        return;
      }
      if (useColourSelectStore.getState().targetNodeId) {
        useColourSelectStore.getState().clearPrompt();
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeMarquee?.();
    this.unsubscribeMarquee = undefined;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.generation++;
  }

  private armDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.fire();
    }, DEBOUNCE_MS);
  }

  private async fire(): Promise<void> {
    const state = useColourSelectStore.getState();
    const { targetNodeId, seeds, params } = state;
    if (!targetNodeId || !hasSeeds(state)) return;

    const payload = this.deps.getPayload(targetNodeId);
    if (!payload) {
      useColourSelectStore.getState().setStatus('error', 'Nothing cooked to select yet');
      return;
    }

    const generation = ++this.generation;
    useColourSelectStore.getState().setStatus('pending');

    const bufferSeeds = docPointsToBuffer(seeds, payload.frame).map((p, i) => ({
      x: p.x,
      y: p.y,
      label: seeds[i].label,
    }));

    try {
      const result = await this.deps.selectColour({
        image: payload.image,
        width: payload.width,
        height: payload.height,
        seeds: bufferSeeds,
        params,
      });
      if (this.generation !== generation) return; // superseded by a newer edit

      useColourSelectStore.getState().setStatus('idle');
      const docPolygons = bufferPolygonsToDoc(result.polygons, payload.frame);
      if (docPolygons.length > 0) {
        this.deps.setMarquee({
          kind: 'polygons',
          polygons: docPolygons,
          label: 'Selection (colour)',
        });
      } else {
        if (useMarqueeStateStore.getState().marquee?.kind === 'polygons') {
          this.suppressNextMarqueeNullClear = true;
        }
        this.deps.setMarquee(null);
      }
    } catch (err) {
      if (this.generation !== generation) return;
      useColourSelectStore
        .getState()
        .setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }
}
