import type { SegmentOptions, SegmentResult } from '@/ai/adapter';
import { sidecarSegmentDriver } from '@/ai/sidecarSegment';
import type { MarqueeShape } from '@/scene/marquee';
import { useMarqueeStateStore } from '@/scene/marquee';
import { bufferPolygonsToDoc, docBoxToBufferBox, docPointsToBuffer } from '../selectShared/coords';
import { getTargetPayload, type TargetPayload } from '../selectShared/payload';
import { hasPrompt, useSmartSelectStore } from './state';

const DEBOUNCE_MS = 150;
/** "pending longer than ~1s" -> the indeterminate downloading state (segment-to-vector.md's client contract). */
const DOWNLOAD_THRESHOLD_MS = 1000;

export interface SmartSelectControllerDeps {
  getPayload: (nodeId: string) => TargetPayload | undefined;
  segment: (options: SegmentOptions) => Promise<SegmentResult>;
  setMarquee: (marquee: MarqueeShape | null) => void;
}

export const productionSmartSelectControllerDeps: SmartSelectControllerDeps = {
  getPayload: getTargetPayload,
  segment: (options) => {
    if (!sidecarSegmentDriver.segment) {
      return Promise.reject(new Error('segment not supported by the configured driver'));
    }
    return sidecarSegmentDriver.segment(options);
  },
  setMarquee: (marquee) => useMarqueeStateStore.getState().setMarquee(marquee),
};

/**
 * Debounces the `select-smart` tool's prompt into sidecar `segment`
 * requests (segment-to-vector.md): every points/box/outline-mask edit
 * re-arms a 150ms debounce; once fired, a request pending >= 1s flips the
 * store's status to `'downloading'` (the first-use weights fetch has no
 * progress frames — this is the client's own heuristic, not a real
 * progress signal). Out-of-order responses (a newer edit fired a second
 * request before the first answered) are dropped via a generation counter
 * — same "supersedes the pending one" idea `CookScheduler` uses for cooks.
 *
 * A class (not a bare module), same reasoning as `CookScheduler`: tests
 * spin up independent instances with mock deps and fake timers.
 */
export class SmartSelectController {
  private readonly deps: SmartSelectControllerDeps;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private unsubscribe?: () => void;
  private unsubscribeMarquee?: () => void;
  /** Set right before THIS controller clears the marquee itself (an empty-polygons response) — the marquee-store subscription below must not treat its own write as an external commit. */
  private suppressNextMarqueeNullClear = false;

  constructor(deps: SmartSelectControllerDeps = productionSmartSelectControllerDeps) {
    this.deps = deps;
  }

  start(): void {
    this.unsubscribe = useSmartSelectStore.subscribe((state, prev) => {
      if (!state.targetNodeId) return;
      const promptChanged =
        state.points !== prev.points ||
        state.box !== prev.box ||
        state.outlineMask !== prev.outlineMask;
      if (!promptChanged) return;
      this.armDebounce();
    });

    // Committing the polygons preview (StackRow's "Mask from selection")
    // clears the MARQUEE store, not this one — without this, the prompt's
    // point/box markers would keep painting after commit (an orphaned
    // overlay, the rule every other tool follows). Reacts to the REAL
    // marquee store directly (not `this.deps.setMarquee`, which tests
    // inject as a plain function) — production-only wiring, same posture
    // as `CookScheduler`'s own store subscriptions.
    //
    // Gated on `prev.marquee?.kind === 'polygons'`: the ONLY marquee this
    // tool's own commit consumes is the polygons preview it produced.
    // Without this gate, activating the tool against an active lasso/rect/
    // ellipse outline would also trip this — `Viewport.tsx`'s activation
    // effect seeds the prompt from that marquee THEN calls `clearMarquee()`
    // to consume it (segment-to-vector.md: "the outline is consumed"), and
    // that clear is a non-null -> null transition too. Reacting to it would
    // wipe the just-seeded box/points before the debounce ever fires,
    // silently killing the outline prompt — the story's own "everyday
    // gesture".
    this.unsubscribeMarquee = useMarqueeStateStore.subscribe((state, prev) => {
      if (state.marquee !== null || prev.marquee?.kind !== 'polygons') return;
      if (this.suppressNextMarqueeNullClear) {
        this.suppressNextMarqueeNullClear = false;
        return;
      }
      if (useSmartSelectStore.getState().targetNodeId) {
        useSmartSelectStore.getState().clearPrompt();
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeMarquee?.();
    this.unsubscribeMarquee = undefined;
    this.clearTimers();
    // Invalidate any in-flight request's response handling — stop() is also
    // called on tool-switch-away, which must not let a late response paint
    // a preview for a prompt nobody's looking at any more.
    this.generation++;
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.debounceTimer = null;
    this.downloadTimer = null;
  }

  private armDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.fire();
    }, DEBOUNCE_MS);
  }

  private async fire(): Promise<void> {
    const state = useSmartSelectStore.getState();
    const { targetNodeId, points, box, outlineMask } = state;
    if (!targetNodeId || !hasPrompt(state)) return;

    const payload = this.deps.getPayload(targetNodeId);
    if (!payload) {
      useSmartSelectStore.getState().setStatus('error', 'Nothing cooked to segment yet');
      return;
    }

    const generation = ++this.generation;
    useSmartSelectStore.getState().setStatus('pending');
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.downloadTimer = setTimeout(() => {
      if (this.generation === generation) useSmartSelectStore.getState().setStatus('downloading');
    }, DOWNLOAD_THRESHOLD_MS);

    const bufferPoints = docPointsToBuffer(points, payload.frame).map((p, i) => ({
      x: p.x,
      y: p.y,
      label: points[i].label,
    }));
    const bufferBox = box ? docBoxToBufferBox(box, payload.frame) : null;

    try {
      const result = await this.deps.segment({
        image: payload.image,
        width: payload.width,
        height: payload.height,
        points: bufferPoints,
        box: bufferBox,
        mask: outlineMask ?? undefined,
      });
      if (this.generation !== generation) return; // superseded by a newer edit

      if (this.downloadTimer) {
        clearTimeout(this.downloadTimer);
        this.downloadTimer = null;
      }
      useSmartSelectStore.getState().setStatus('idle');
      const docPolygons = bufferPolygonsToDoc(result.polygons, payload.frame);
      if (docPolygons.length > 0) {
        // `label` (colour-range-select.md's `store.ts` change): stamps this
        // tool's own commit label onto the marquee it writes, since
        // `applyMarqueeAsVectorMask` can no longer assume every `polygons`
        // marquee came from `select-smart`.
        this.deps.setMarquee({
          kind: 'polygons',
          polygons: docPolygons,
          label: 'Selection (segment)',
        });
      } else {
        // Only arm the suppression when this call will actually cause a
        // non-null -> null transition (the common "no result yet" case
        // starts from an already-null marquee) — arming it unconditionally
        // would swallow the NEXT real external clear (a later StackRow
        // commit) instead of this non-event, reopening the orphaned-marker
        // bug the subscription exists to prevent.
        // Matches the subscription's own gate exactly (only a polygons ->
        // null transition is ever reacted to) — arming for any other
        // non-null marquee would leave the flag set, unconsumed, ready to
        // swallow a LATER real polygons -> null commit.
        if (useMarqueeStateStore.getState().marquee?.kind === 'polygons') {
          this.suppressNextMarqueeNullClear = true;
        }
        this.deps.setMarquee(null);
      }
    } catch (err) {
      if (this.generation !== generation) return;
      if (this.downloadTimer) {
        clearTimeout(this.downloadTimer);
        this.downloadTimer = null;
      }
      useSmartSelectStore
        .getState()
        .setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }
}
