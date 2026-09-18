import * as cache from '@/scene/cache';
import { sceneChangedIgnoringDirty } from '@/scene/sceneDiff';
import { useSceneStore } from '@/scene/store';
import { useSidecarStatusStore } from '@/sidecar/client';
import { type CookLevel, cookNode, cookNodeFullRes, resetCookErrorBurst } from './cook';

const DRAFT_THROTTLE_MS = 80;
const WORKING_IDLE_MS = 400;
const CONCURRENCY = 2;

export type Executor = (nodeId: string, level: CookLevel) => Promise<void>;

/**
 * One-shot full-res cook for a locked node with an empty `baked` cache slot
 * (lock-state-machine.md's rehydrate path). Injectable so tests can mock it
 * the same way they mock `Executor`.
 */
export type RehydrateExecutor = (nodeId: string) => Promise<ImageBitmap>;

async function productionRehydrate(nodeId: string): Promise<ImageBitmap> {
  return cookNodeFullRes(nodeId);
}

interface JobState {
  inFlight: boolean;
  /** A newer request arrived while this job was in flight — requeue on completion. */
  pending: boolean;
  /** Sitting in a queue, not yet started. */
  queued: boolean;
}

/**
 * Watches the scene store and keeps caches fresh. Rules (design/architecture.md
 * §Cook scheduler, cook-pipeline.md):
 *
 * - Dirty appears -> 80ms throttle -> enqueue DRAFT cooks for draft-dirty nodes,
 *   and again every 80ms for as long as mutations keep arriving (scrubbing).
 * - No store mutation for 400ms -> enqueue WORKING cooks for working-dirty nodes.
 * - Per node x level: at most one in-flight and one pending; a newer request
 *   supersedes the pending one (dedup, not a new queue entry).
 * - Global concurrency 2, FIFO, DRAFT queue always drained before WORKING.
 * - On sidecar-status: up, reset the error-burst toast flag and re-enqueue
 *   every currently-dirty node/level — the auto-recook-after-restart rule.
 *
 * A class (not a bare module) so tests can spin up independent instances
 * with a mock executor, mirroring `SidecarClient`.
 */
export class CookScheduler {
  private readonly executor: Executor;
  private readonly rehydrateExecutor: RehydrateExecutor;
  private readonly jobStates = new Map<string, JobState>();
  private readonly draftQueue: string[] = [];
  private readonly workingQueue: string[] = [];
  /** Locked node ids currently rehydrating (lock-state-machine.md) — separate from `jobStates`, which is draft/working only. */
  private readonly rehydrating = new Set<string>();
  private activeCount = 0;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private workingTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeScene?: () => void;
  private unsubscribeStatus?: () => void;

  constructor(
    executor: Executor = cookNode,
    rehydrateExecutor: RehydrateExecutor = productionRehydrate,
  ) {
    this.executor = executor;
    this.rehydrateExecutor = rehydrateExecutor;
  }

  start(): void {
    // Fresh-load case (lock-state-machine.md): a scene loaded with locked
    // nodes whose `baked` cache is empty (persistence hasn't shipped yet, or
    // the cache was never populated this session) needs rehydrating right
    // away, not just on the next scene mutation.
    this.rehydrateLocked();

    this.unsubscribeScene = useSceneStore.subscribe((state, prev) => {
      if (state.scene === prev.scene) return;
      // Rehydrate check runs on every scene tick (cheap — cache lookup + a
      // Set membership check per locked node — and idempotent), independent
      // of the real-edit-vs-churn filter below: it must also fire for
      // dirty-flag-only churn (e.g. clearDirty right after an unlock) and
      // for undo/redo's own `loadScene` call.
      this.rehydrateLocked();

      // Cook churn (clearDirty/markDirty swap the scene object but change
      // only dirty flags) must NOT re-arm the timers: every completing draft
      // cook would push pending WORKING cooks out another 400ms — with a few
      // nodes cooking, working-res results starve ("grain takes ages to kick
      // in", Georg 2026-07-05). Only a real edit resets the idle clock; the
      // timer callbacks read dirty state fresh at fire time, so dirty set by
      // markDirty right after a real edit (project load) is still picked up.
      if (!sceneChangedIgnoringDirty(prev.scene, state.scene)) return;
      this.armDraftThrottle();
      this.armWorkingIdle();
    });

    this.unsubscribeStatus = useSidecarStatusStore.subscribe((state, prev) => {
      if (state.status === 'up' && prev.status !== 'up') {
        resetCookErrorBurst();
        this.retryAllDirty();
        // Locked nodes carry no dirty flag, so retryAllDirty() never touches
        // them — a rehydrate that failed while the sidecar was down (e.g.
        // redo-into-locked during an outage) needs this same auto-recook-
        // after-restart rule, or it stays blank until an unrelated edit.
        this.rehydrateLocked();
      }
    });
  }

  /**
   * Locked-node recovery (lock-state-machine.md): a locked node whose
   * `baked` cache slot is empty gets a one-shot full-res cook. The single
   * recovery path for fresh loads, undo-into-locked, and (later)
   * missing/corrupt persisted PNGs — never a silent unlock, never a
   * permanent blank. At most one rehydrate in flight per node.
   */
  private rehydrateLocked(): void {
    for (const node of useSceneStore.getState().scene.nodes) {
      if (node.state !== 'locked') continue;
      if (cache.get(node.id, 'baked')) continue;
      if (this.rehydrating.has(node.id)) continue;

      this.rehydrating.add(node.id);
      void this.rehydrateExecutor(node.id)
        .then((bitmap) => cache.set(node.id, 'baked', bitmap))
        .catch((err) => {
          // Not (yet) toast-worthy per lock-state-machine.md — corrupt/missing
          // persisted PNGs are baked-persistence.md's problem; today this can
          // only fail if the node's own source/modifiers are broken, same
          // failure surface `cookNode` already logs rather than blocking.
          console.error(`[lock] rehydrate failed for ${node.id}:`, err);
        })
        .finally(() => {
          this.rehydrating.delete(node.id);
        });
    }
  }

  stop(): void {
    this.unsubscribeScene?.();
    this.unsubscribeStatus?.();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.workingTimer) clearTimeout(this.workingTimer);
    this.draftTimer = null;
    this.workingTimer = null;
  }

  /**
   * DRAFT is throttled, not debounced: an already-armed timer is left
   * alone rather than pushed out by the next mutation. A scrub-drag fires
   * `onChange` on every pointermove (~8ms apart), so a re-arming timer
   * never reaches its 80ms deadline until the drag *stops* — the canvas
   * stayed frozen on the pre-drag WORKING bitmap for the whole gesture,
   * which is the "low-res while scrubbing" half of architecture.md's cook
   * loop never actually happening (Georg, 2026-09-19). Not re-arming gives
   * a steady 80ms draft cadence under sustained mutation; the timer
   * callback reads dirty state fresh at fire time, so each cook uses the
   * latest params, and the per-node in-flight/pending dedup keeps a slow
   * cook from stacking up requests.
   *
   * WORKING stays a true debounce — it's explicitly the "user has stopped"
   * signal (`armWorkingIdle`).
   */
  private armDraftThrottle(): void {
    if (this.draftTimer) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      for (const node of useSceneStore.getState().scene.nodes) {
        // Locked nodes are never scheduled from dirty flags (lock-state-
        // machine.md) — defence in depth alongside the store's own mutation
        // guards, which should already keep a locked node's dirty flags
        // false at all times.
        if (node.state === 'locked') continue;
        if (node.dirty.draft) this.enqueue(node.id, 'draft');
      }
    }, DRAFT_THROTTLE_MS);
  }

  private armWorkingIdle(): void {
    if (this.workingTimer) clearTimeout(this.workingTimer);
    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      for (const node of useSceneStore.getState().scene.nodes) {
        if (node.state === 'locked') continue;
        if (node.dirty.working) this.enqueue(node.id, 'working');
      }
    }, WORKING_IDLE_MS);
  }

  private retryAllDirty(): void {
    for (const node of useSceneStore.getState().scene.nodes) {
      if (node.state === 'locked') continue;
      if (node.dirty.draft) this.enqueue(node.id, 'draft');
      if (node.dirty.working) this.enqueue(node.id, 'working');
    }
  }

  private queueFor(level: CookLevel): string[] {
    return level === 'draft' ? this.draftQueue : this.workingQueue;
  }

  private enqueue(nodeId: string, level: CookLevel): void {
    const key = `${level}:${nodeId}`;
    let state = this.jobStates.get(key);
    if (!state) {
      state = { inFlight: false, pending: false, queued: false };
      this.jobStates.set(key, state);
    }

    if (state.inFlight) {
      state.pending = true;
      return;
    }
    if (state.queued) return; // already sitting in the queue — no duplicate entry

    state.queued = true;
    this.queueFor(level).push(nodeId);
    this.runNext();
  }

  /** DRAFT always drains before WORKING; FIFO within each priority. */
  private pullNext(): { nodeId: string; level: CookLevel } | undefined {
    if (this.draftQueue.length > 0) {
      return { nodeId: this.draftQueue.shift() as string, level: 'draft' };
    }
    if (this.workingQueue.length > 0) {
      return { nodeId: this.workingQueue.shift() as string, level: 'working' };
    }
    return undefined;
  }

  private runNext(): void {
    while (this.activeCount < CONCURRENCY) {
      const next = this.pullNext();
      if (!next) return;
      this.runJob(next.nodeId, next.level);
    }
  }

  private runJob(nodeId: string, level: CookLevel): void {
    const key = `${level}:${nodeId}`;
    const state = this.jobStates.get(key);
    if (!state) return;

    state.queued = false;
    state.inFlight = true;
    this.activeCount++;

    void this.executor(nodeId, level)
      .catch(() => {
        // The executor owns its own failure handling (toast, stale-cache
        // retention); the scheduler only needs to know the slot is free.
      })
      .finally(() => {
        this.activeCount--;
        state.inFlight = false;
        if (state.pending) {
          state.pending = false;
          state.queued = true;
          this.queueFor(level).push(nodeId);
        } else {
          this.jobStates.delete(key);
        }
        this.runNext();
      });
  }
}
