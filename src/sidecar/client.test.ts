import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidecarClient, useSidecarStatusStore } from './client';
import { encodeFrame } from './frame';
import { useOpsCacheStore } from './opsCache';
import type { SidecarStatusEvent, SidecarTransport } from './transport';

/** Minimal in-memory transport: captures sent frames, lets tests push frames/status back in. */
class MockTransport implements SidecarTransport {
  sent: Uint8Array[] = [];
  private frameCbs: Array<(chunk: Uint8Array) => void> = [];
  private statusCbs: Array<(status: SidecarStatusEvent) => void> = [];
  sendImpl: (bytes: Uint8Array) => Promise<void> = async () => {};

  async send(bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes);
    await this.sendImpl(bytes);
  }

  onFrame(cb: (chunk: Uint8Array) => void): () => void {
    this.frameCbs.push(cb);
    return () => {
      this.frameCbs = this.frameCbs.filter((c) => c !== cb);
    };
  }

  onStatus(cb: (status: SidecarStatusEvent) => void): () => void {
    this.statusCbs.push(cb);
    return () => {
      this.statusCbs = this.statusCbs.filter((c) => c !== cb);
    };
  }

  emitFrame(chunk: Uint8Array): void {
    for (const cb of this.frameCbs) cb(chunk);
  }

  emitStatus(status: SidecarStatusEvent): void {
    for (const cb of this.statusCbs) cb(status);
  }

  /** Reads the id off the most recently sent frame's header. */
  lastSentId(): string {
    const frame = this.sent[this.sent.length - 1];
    const headerLen = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
      0,
      true,
    );
    const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headerLen)));
    return header.id;
  }
}

describe('SidecarClient.request', () => {
  let transport: MockTransport;
  let client: SidecarClient;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new MockTransport();
    client = new SidecarClient(transport);
    client.start();
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  it('resolves when a matching response frame arrives', async () => {
    const promise = client.request({ op: 'ping' });
    const id = transport.lastSentId();

    transport.emitFrame(encodeFrame({ id, ok: true, version: '0.1.0' }));

    const response = await promise;
    expect(response.header.ok).toBe(true);
    expect(response.header.version).toBe('0.1.0');
  });

  it('reassembles a response split across chunks delivered via the transport', async () => {
    const promise = client.request({ op: 'debug_echo' }, new Uint8Array([1, 2, 3]));
    const id = transport.lastSentId();

    const response = encodeFrame({ id, ok: true }, new Uint8Array([9, 9, 9]));
    const mid = Math.floor(response.byteLength / 2);
    transport.emitFrame(response.subarray(0, mid));
    transport.emitFrame(response.subarray(mid));

    const result = await promise;
    expect(Array.from(result.payload)).toEqual([9, 9, 9]);
  });

  it('rejects on ok:false with the error string', async () => {
    const promise = client.request({ op: 'frobnicate' });
    const id = transport.lastSentId();

    transport.emitFrame(encodeFrame({ id, ok: false, error: "unknown op 'frobnicate'" }));

    await expect(promise).rejects.toThrow("unknown op 'frobnicate'");
  });

  it('rejects after the timeout elapses with no response', async () => {
    const promise = client.request({ op: 'ping' });
    const assertion = expect(promise).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
  });

  it('keeps serving subsequent requests after a rejection', async () => {
    const failing = client.request({ op: 'boom' });
    const failId = transport.lastSentId();
    transport.emitFrame(encodeFrame({ id: failId, ok: false, error: 'deliberate failure' }));
    await expect(failing).rejects.toThrow('deliberate failure');

    const succeeding = client.request({ op: 'ping' });
    const okId = transport.lastSentId();
    transport.emitFrame(encodeFrame({ id: okId, ok: true, version: '0.1.0' }));
    await expect(succeeding).resolves.toMatchObject({ header: { ok: true } });
  });
});

describe('SidecarClient status handling', () => {
  let transport: MockTransport;
  let client: SidecarClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new SidecarClient(transport);
    client.start();
    useSidecarStatusStore.setState({ status: 'down', lastError: undefined });
    useOpsCacheStore.setState({ ops: [], categories: [] });
  });

  afterEach(() => {
    client.stop();
  });

  it('flips the status store on a status event', () => {
    transport.emitStatus({ up: true });
    expect(useSidecarStatusStore.getState().status).toBe('up');

    transport.emitStatus({ up: false, error: 'sidecar exited: signal 9' });
    expect(useSidecarStatusStore.getState().status).toBe('down');
    expect(useSidecarStatusStore.getState().lastError).toBe('sidecar exited: signal 9');
  });

  it('re-issues list_ops and caches the result when status goes up', async () => {
    transport.emitStatus({ up: true });

    // The status handler fired a list_ops request; answer it.
    const id = transport.lastSentId();
    const ops = [{ name: 'debug_echo', backend: 'python', params: [] }];
    transport.emitFrame(encodeFrame({ id, ok: true, ops }));

    // Let the microtask queue drain so the promise resolution updates the store.
    await Promise.resolve();
    await Promise.resolve();

    expect(useOpsCacheStore.getState().ops).toEqual(ops);
  });

  it("caches the sidecar's category list, in its order, beside the ops", async () => {
    transport.emitStatus({ up: true });

    const id = transport.lastSentId();
    const ops = [{ name: 'invert', backend: 'python', params: [], category: 'colour' }];
    const categories = [
      { id: 'colour', label: 'Colour' },
      { id: 'film', label: 'Film' },
    ];
    transport.emitFrame(encodeFrame({ id, ok: true, ops, categories }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useOpsCacheStore.getState().categories).toEqual(categories);
  });
});
