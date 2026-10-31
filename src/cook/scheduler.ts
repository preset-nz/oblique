import * as cache from '@/scene/cache';
import { dependsOnLayer, pixelDriversOf } from '@/scene/maskInputs';
import { dirtyRose, sceneChangedIgnoringDirty } from '@/scene/sceneDiff';
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
 * - Global concurrency 2, FIFO, a runnable DRAFT job always before any WORKING one.
 * - Drivers before consumers (layer-as-driver.md, architecture rule 4's exception): a node
 *   whose modifier is masked by a pixel layer waits, at a level, while that driver has a cook
 *   queued, in flight or pending at the same level, so it reads the driver's fresh raster.
 *   Waiting never blocks the queue: the next runnable job goes instead, so independent nodes
 *   still cook two at a time. A driver that is dirty but has no job (no source, a failed
 *   cook) holds nothing up, and a cycle (attaching refuses them) is never waited on. When a
 *   driver's cook finishes, its consumers dirty at that level are enqueued.
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
      // A dirty flag RISING with no real edit is not churn though: the font
      // catalogue becoming ready dirties text nodes on its own (missing-fonts.md)
      // and nothing else would ever wake the scheduler for it.
      if (
        !sceneChangedIgnoringDirty(prev.scene, state.scene) &&
        !dirtyRose(prev.scene, state.scene)
      ) {
        return;
      }
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
          // a consumer waiting on this locked driver's bake can go now
          this.runNext();
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
        if (node.dirty.draft) this.enqueue(node.id, 'draft', false);
      }
      // Started only once the whole pass is queued, so a consumer listed above its driver
      // can see the driver's job and wait for it.
      this.runNext();
    }, DRAFT_THROTTLE_MS);
  }

  private armWorkingIdle(): void {
    if (this.workingTimer) clearTimeout(this.workingTimer);
    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      for (const node of useSceneStore.getState().scene.nodes) {
        if (node.state === 'locked') continue;
        if (node.dirty.working) this.enqueue(node.id, 'working', false);
      }
      this.runNext();
    }, WORKING_IDLE_MS);
  }

  private retryAllDirty(): void {
    for (const node of useSceneStore.getState().scene.nodes) {
      if (node.state === 'locked') continue;
      if (node.dirty.draft) this.enqueue(node.id, 'draft', false);
      if (node.dirty.working) this.enqueue(node.id, 'working', false);
    }
    this.runNext();
  }

  private queueFor(level: CookLevel): string[] {
    return level === 'draft' ? this.draftQueue : this.workingQueue;
  }

  private enqueue(nodeId: string, level: CookLevel, run = true): void {
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
    if (run) this.runNext();
  }

  /** A cook for this node/level is queued, in flight, or due to run again. */
  private busy(nodeId: string, level: CookLevel): boolean {
    const state = this.jobStates.get(`${level}:${nodeId}`);
    return state !== undefined && (state.queued || state.inFlight || state.pending);
  }

  /**
   * The pixel drivers `nodeId` has to wait for at `level` (layer-as-driver.md): its direct
   * drivers with a cook queued, in flight or pending there, or (a locked driver) its bake being
   * rebuilt, which is the raster a consumer reads then. A driver that itself depends on
   * `nodeId` (a cycle from a document made elsewhere) is never waited on, so a cycle can't
   * stall the queue.
   */
  private waitsOnDriver(nodeId: string, level: CookLevel): boolean {
    const scene = useSceneStore.getState().scene;
    const node = scene.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    const getRef = (id: string) => scene.maskRefs?.[id];
    const getNode = (id: string) => scene.nodes.find((n) => n.id === id);
    return pixelDriversOf(node, getRef).some(
      (driver) =>
        driver !== nodeId &&
        (this.busy(driver, level) || this.rehydrating.has(driver)) &&
        !dependsOnLayer(driver, nodeId, getNode, getRef),
    );
  }

  /**
   * A runnable DRAFT job before any WORKING one; FIFO within each priority, skipping a job whose
   * driver hasn't cooked at that level yet (it stays in place and goes once the driver is done).
   * When every queued DRAFT job is waiting on a driver, a WORKING job takes the free slot.
   */
  private pullNext(): { nodeId: string; level: CookLevel } | undefined {
    for (const level of ['draft', 'working'] as const) {
      const queue = this.queueFor(level);
      const i = queue.findIndex((id) => !this.waitsOnDriver(id, level));
      if (i !== -1) return { nodeId: queue.splice(i, 1)[0], level };
    }
    return undefined;
  }

  /**
   * After a driver's cook at `level`: its consumers that are dirty there get a cook, so the
   * fresh raster is read even when nothing else would wake them. Same level only, so a draft
   * cook never starts WORKING work ahead of the idle timer.
   */
  private enqueueConsumers(driverId: string, level: CookLevel): void {
    const scene = useSceneStore.getState().scene;
    const getRef = (id: string) => scene.maskRefs?.[id];
    for (const node of scene.nodes) {
      if (node.state === 'locked' || node.id === driverId || !node.dirty[level]) continue;
      if (pixelDriversOf(node, getRef).includes(driverId)) this.enqueue(node.id, level, false);
    }
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
        this.enqueueConsumers(nodeId, level);
        this.runNext();
      });
  }
}
