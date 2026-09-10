import { beforeEach, describe, expect, it } from 'vitest';
import { useSidecarStatusStore } from '@/sidecar/client';
import { canInpaint, canSegment } from './adapter';
import { sidecarSegmentDriver } from './sidecarSegment';

describe('sidecar segment driver stub', () => {
  beforeEach(() => {
    useSidecarStatusStore.setState({ status: 'down', lastError: undefined });
  });

  it('declares only the segment capability', () => {
    expect(canSegment(sidecarSegmentDriver)).toBe(true);
    expect(canInpaint(sidecarSegmentDriver)).toBe(false);
  });

  it('health reflects the sidecar being up', async () => {
    useSidecarStatusStore.setState({ status: 'up', lastError: undefined });
    expect(await sidecarSegmentDriver.health()).toEqual({ ok: true, detail: 'Connected' });
  });

  it('health reflects the sidecar being down, with its last error', async () => {
    useSidecarStatusStore.setState({ status: 'down', lastError: 'sidecar exited: signal 9' });
    expect(await sidecarSegmentDriver.health()).toEqual({
      ok: false,
      detail: 'sidecar exited: signal 9',
    });
  });

  it('health reflects the sidecar being down with no recorded error', async () => {
    useSidecarStatusStore.setState({ status: 'down', lastError: undefined });
    expect(await sidecarSegmentDriver.health()).toEqual({
      ok: false,
      detail: 'Sidecar not running',
    });
  });
});
