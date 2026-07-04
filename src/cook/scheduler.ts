import { useSceneStore } from '@/scene/store';
import { useSidecarStatusStore } from '@/sidecar/client';
import { type CookLevel, cookNode, resetCookErrorBurst } from './cook';

const DRAFT_DEBOUNCE_MS = 80;
const WORKING_IDLE_MS = 400;
const CONCURRENCY = 2;

export type Executor = (nodeId: string, level: CookLevel) => Promise<void>;

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
 * - Dirty appears -> 80ms debounce -> enqueue DRAFT cooks for draft-dirty nodes.
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
  private readonly jobStates = new Map<string, JobState>();
  private readonly draftQueue: string[] = [];
  private readonly workingQueue: string[] = [];
  private activeCount = 0;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private workingTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeScene?: () => void;
  private unsubscribeStatus?: () => void;

  constructor(executor: Executor = cookNode) {
    this.executor = executor;
  }

  start(): void {
    this.unsubscribeScene = useSceneStore.subscribe((state, prev) => {
      if (state.scene === prev.scene) return;
      this.armDraftDebounce();
      this.armWorkingIdle();
    });

    this.unsubscribeStatus = useSidecarStatusStore.subscribe((state, prev) => {
      if (state.status === 'up' && prev.status !== 'up') {
        resetCookErrorBurst();
        this.retryAllDirty();
      }
    });
  }

  stop(): void {
    this.unsubscribeScene?.();
    this.unsubscribeStatus?.();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.workingTimer) clearTimeout(this.workingTimer);
    this.draftTimer = null;
    this.workingTimer = null;
  }

  private armDraftDebounce(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      for (const node of useSceneStore.getState().scene.nodes) {
        if (node.dirty.draft) this.enqueue(node.id, 'draft');
      }
    }, DRAFT_DEBOUNCE_MS);
  }

  private armWorkingIdle(): void {
    if (this.workingTimer) clearTimeout(this.workingTimer);
    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      for (const node of useSceneStore.getState().scene.nodes) {
        if (node.dirty.working) this.enqueue(node.id, 'working');
      }
    }, WORKING_IDLE_MS);
  }

  private retryAllDirty(): void {
    for (const node of useSceneStore.getState().scene.nodes) {
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
