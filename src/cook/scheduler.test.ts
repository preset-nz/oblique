import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneStore } from '@/scene/store';
import type { SceneNode } from '@/scene/types';
import { useSidecarStatusStore } from '@/sidecar/client';
import { CookScheduler, type Executor } from './scheduler';

function makeNode(id: string, overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    label: id,
    type: 'pixel',
    state: 'active',
    output: 'image',
    cameraId: null,
    modifiers: [],
    visible: true,
    blendMode: 'normal',
    opacity: 1,
    dirty: { draft: false, working: false },
    ...overrides,
  } as SceneNode;
}

function emptyScene() {
  return {
    id: 'scene-1',
    nodes: [] as SceneNode[],
    cameras: [],
    defaultCameraId: null,
    resolution: 'working' as const,
    documentSize: [0, 0] as [number, number],
  };
}

/** Deferred-resolve executor stub: tests control exactly when each cook "finishes". */
function makeControlledExecutor() {
  const calls: Array<{ nodeId: string; level: 'draft' | 'working' }> = [];
  const resolvers: Array<() => void> = [];
  const executor: Executor = (nodeId, level) => {
    calls.push({ nodeId, level });
    return new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });
  };
  return {
    executor,
    calls,
    resolveNext: () => resolvers.shift()?.(),
    resolveAll: () => {
      while (resolvers.length) resolvers.shift()?.();
    },
  };
}

function setNodes(nodes: SceneNode[]) {
  useSceneStore.setState({ scene: { ...emptyScene(), nodes } });
}

describe('CookScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setNodes([]);
    useSidecarStatusStore.setState({ status: 'down', lastError: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces 80ms before enqueuing a DRAFT cook for a dirty node', async () => {
    const executor = vi.fn(async () => {});
    const scheduler = new CookScheduler(executor);
    scheduler.start();

    setNodes([makeNode('a', { dirty: { draft: true, working: true } })]);

    await vi.advanceTimersByTimeAsync(79);
    expect(executor).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(executor).toHaveBeenCalledWith('a', 'draft');

    scheduler.stop();
  });

  it('promotes to WORKING after 400ms of no further store mutation', async () => {
    const executor = vi.fn(async () => {});
    const scheduler = new CookScheduler(executor);
    scheduler.start();

    setNodes([makeNode('a', { dirty: { draft: true, working: true } })]);
    await vi.advanceTimersByTimeAsync(80);
    expect(executor).toHaveBeenCalledWith('a', 'draft');
    executor.mockClear();

    // No further mutation: idle timer should fire at 400ms from the last one.
    await vi.advanceTimersByTimeAsync(400);
    expect(executor).toHaveBeenCalledWith('a', 'working');

    scheduler.stop();
  });

  it('resets the idle timer on continued mutation (scrubbing keeps WORKING at bay)', async () => {
    const executor = vi.fn(async () => {});
    const scheduler = new CookScheduler(executor);
    scheduler.start();

    setNodes([makeNode('a', { dirty: { draft: true, working: true } })]);
    await vi.advanceTimersByTimeAsync(100);
    executor.mockClear();

    // Keep mutating every 200ms — under the 400ms idle bar — several times.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(200);
      setNodes([makeNode('a', { dirty: { draft: false, working: true } })]);
    }
    expect(executor).not.toHaveBeenCalledWith('a', 'working');

    // Now go quiet for the full idle window.
    await vi.advanceTimersByTimeAsync(400);
    expect(executor).toHaveBeenCalledWith('a', 'working');

    scheduler.stop();
  });

  it('supersession: a newer request while in flight replaces the pending one (runs once more, not twice)', async () => {
    const { executor, calls, resolveNext } = makeControlledExecutor();
    const scheduler = new CookScheduler(executor);
    scheduler.start();

    setNodes([makeNode('a', { dirty: { draft: true, working: true } })]);
    await vi.advanceTimersByTimeAsync(80);
    expect(calls).toEqual([{ nodeId: 'a', level: 'draft' }]);

    // Re-dirty while the first draft cook is still in flight.
    setNodes([makeNode('a', { dirty: { draft: true, working: true } })]);
    await vi.advanceTimersByTimeAsync(80);
    // Superseded, not queued again yet (still in flight) — still only one call so far.
    expect(calls).toEqual([{ nodeId: 'a', level: 'draft' }]);

    // Re-dirty again — supersession should still just mark "pending", not stack up.
    setNodes([makeNode('a', { dirty: { draft: true, working: true } })]);
    await vi.advanceTimersByTimeAsync(80);
    expect(calls).toEqual([{ nodeId: 'a', level: 'draft' }]);

    // Finish the in-flight cook: exactly one more run should follow (the superseded one).
    resolveNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([
      { nodeId: 'a', level: 'draft' },
      { nodeId: 'a', level: 'draft' },
    ]);

    resolveNext();
    scheduler.stop();
  });

  it('caps global concurrency at 2 and runs the rest FIFO as slots free up', async () => {
    const { executor, calls, resolveNext } = makeControlledExecutor();
    const scheduler = new CookScheduler(executor);
    scheduler.start();

    setNodes([
      makeNode('a', { dirty: { draft: true, working: true } }),
      makeNode('b', { dirty: { draft: true, working: true } }),
      makeNode('c', { dirty: { draft: true, working: true } }),
    ]);
    await vi.advanceTimersByTimeAsync(80);

    // Only 2 of the 3 dirty nodes should have started.
    expect(calls).toHaveLength(2);

    resolveNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(3);

    resolveNext();
    resolveNext();
    scheduler.stop();
  });

  it('DRAFT is prioritised over WORKING in the queue', async () => {
    const { executor, calls, resolveNext } = makeControlledExecutor();
    const scheduler = new CookScheduler(executor);
    scheduler.start();

    // Three nodes: two occupy the concurrency-2 budget, a third is WORKING-dirty
    // and queued behind them; once a slot frees, a DRAFT-dirty node should
    // jump ahead of the already-queued WORKING one.
    setNodes([
      makeNode('busy1', { dirty: { draft: true, working: true } }),
      makeNode('busy2', { dirty: { draft: true, working: true } }),
    ]);
    await vi.advanceTimersByTimeAsync(80);
    expect(calls).toHaveLength(2);

    // Idle-promote a WORKING job onto the (full) scheduler — it queues.
    setNodes([
      makeNode('busy1', { dirty: { draft: true, working: true } }),
      makeNode('busy2', { dirty: { draft: true, working: true } }),
      makeNode('workingNode', { dirty: { draft: false, working: true } }),
    ]);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(2); // still just the two originals in flight

    // Now a fresh DRAFT dirty appears on a new node — also queues, behind the FIFO working entry.
    setNodes([
      makeNode('busy1', { dirty: { draft: true, working: true } }),
      makeNode('busy2', { dirty: { draft: true, working: true } }),
      makeNode('workingNode', { dirty: { draft: false, working: true } }),
      makeNode('draftNode', { dirty: { draft: true, working: false } }),
    ]);
    await vi.advanceTimersByTimeAsync(80);

    // Free one slot: the DRAFT job must run before the earlier-queued WORKING job.
    resolveNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls[2]).toEqual({ nodeId: 'draftNode', level: 'draft' });

    resolveNext();
    resolveNext();
    resolveNext();
    scheduler.stop();
  });

  it('auto-retries dirty nodes when the sidecar comes back up', async () => {
    const executor = vi.fn(async () => {});
    const scheduler = new CookScheduler(executor);
    scheduler.start();

    setNodes([makeNode('a', { dirty: { draft: true, working: true } })]);
    await vi.advanceTimersByTimeAsync(80);
    executor.mockClear();

    useSidecarStatusStore.setState({ status: 'up' });
    // Node is still dirty (cook never actually cleared it via a real executor) —
    // the status transition should re-enqueue it immediately, no debounce needed.
    expect(executor).toHaveBeenCalledWith('a', 'draft');

    scheduler.stop();
  });
});
