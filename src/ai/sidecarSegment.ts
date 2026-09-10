import { useSidecarStatusStore } from '@/sidecar/client';
import type { AiAdapter, AiTask, HealthResult } from './adapter';

/**
 * Sidecar-hosted segmentation driver (Epic 17 story 1 — stub; `segment`
 * itself lands in story 2 / segment-to-vector.md, MobileSAM via
 * onnxruntime in the sidecar, not over HTTP — epic decision). `health`
 * reuses the connection status the app already tracks (`src/sidecar/client.ts`)
 * rather than issuing a second probe.
 */
const capabilities: ReadonlySet<AiTask> = new Set<AiTask>(['segment']);

export const sidecarSegmentDriver: AiAdapter = {
  capabilities,
  async health(): Promise<HealthResult> {
    const { status, lastError } = useSidecarStatusStore.getState();
    if (status === 'up') return { ok: true, detail: 'Connected' };
    return { ok: false, detail: lastError ?? 'Sidecar not running' };
  },
  // segment: deferred — segment-to-vector.md (story 2)
};
