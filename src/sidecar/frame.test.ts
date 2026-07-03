import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameReassembler, tryDecodeFrame } from './frame';

describe('encodeFrame / tryDecodeFrame round-trip', () => {
  it('round-trips a header with no payload', () => {
    const encoded = encodeFrame({ id: 'abc', op: 'ping' });
    const result = tryDecodeFrame(encoded);

    expect(result).not.toBeNull();
    expect(result?.frame.header).toEqual({ id: 'abc', op: 'ping', payload_bytes: 0 });
    expect(result?.frame.payload.byteLength).toBe(0);
    expect(result?.bytesConsumed).toBe(encoded.byteLength);
  });

  it('round-trips a header with a payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeFrame({ id: 'xyz', ok: true }, payload);
    const result = tryDecodeFrame(encoded);

    expect(result?.frame.header).toEqual({ id: 'xyz', ok: true, payload_bytes: 5 });
    expect(Array.from(result?.frame.payload ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips a large (10 MB) payload', () => {
    const payload = new Uint8Array(10 * 1024 * 1024);
    // Cheap deterministic fill (avoids a slow per-byte modulo loop over 10 MB).
    for (let i = 0; i < 256; i++) payload.fill(i, i * 40960, (i + 1) * 40960);

    const encoded = encodeFrame({ id: 'big' }, payload);
    const result = tryDecodeFrame(encoded);

    const decoded = result?.frame.payload ?? new Uint8Array(0);
    expect(result?.frame.header.payload_bytes).toBe(payload.byteLength);
    expect(decoded.byteLength).toBe(payload.byteLength);

    // Byte-exact comparison without a large-array deep-equal (slow in vitest's diff engine).
    let mismatchIndex = -1;
    for (let i = 0; i < payload.byteLength; i++) {
      if (decoded[i] !== payload[i]) {
        mismatchIndex = i;
        break;
      }
    }
    expect(mismatchIndex).toBe(-1);
  });

  it('returns null when the buffer is shorter than the length prefix', () => {
    expect(tryDecodeFrame(new Uint8Array([1, 2]))).toBeNull();
  });

  it('returns null when the header is not fully buffered yet', () => {
    const encoded = encodeFrame({ id: 'partial' });
    expect(tryDecodeFrame(encoded.subarray(0, 5))).toBeNull();
  });

  it('returns null when the payload is not fully buffered yet', () => {
    const encoded = encodeFrame({ id: 'partial' }, new Uint8Array([1, 2, 3, 4]));
    expect(tryDecodeFrame(encoded.subarray(0, encoded.byteLength - 1))).toBeNull();
  });
});

describe('FrameReassembler', () => {
  it('reassembles a frame split across two chunks', () => {
    const encoded = encodeFrame({ id: 'split' }, new Uint8Array([9, 8, 7]));
    const splitPoint = Math.floor(encoded.byteLength / 2);

    const reassembler = new FrameReassembler();
    const firstResult = reassembler.push(encoded.subarray(0, splitPoint));
    expect(firstResult).toEqual([]);

    const secondResult = reassembler.push(encoded.subarray(splitPoint));
    expect(secondResult).toHaveLength(1);
    expect(secondResult[0].header.id).toBe('split');
    expect(Array.from(secondResult[0].payload)).toEqual([9, 8, 7]);
  });

  it('reassembles a frame delivered as many small chunks (byte-at-a-time)', () => {
    const encoded = encodeFrame({ id: 'trickle' }, new Uint8Array([1, 2, 3]));
    const reassembler = new FrameReassembler();

    const frames = [];
    for (const byte of encoded) {
      frames.push(...reassembler.push(new Uint8Array([byte])));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0].header.id).toBe('trickle');
  });

  it('emits multiple frames delivered in a single chunk', () => {
    const first = encodeFrame({ id: 'one' });
    const second = encodeFrame({ id: 'two' }, new Uint8Array([1]));
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first, 0);
    combined.set(second, first.byteLength);

    const reassembler = new FrameReassembler();
    const frames = reassembler.push(combined);

    expect(frames).toHaveLength(2);
    expect(frames[0].header.id).toBe('one');
    expect(frames[1].header.id).toBe('two');
  });

  it('carries a partial trailing frame over to the next push', () => {
    const first = encodeFrame({ id: 'complete' });
    const second = encodeFrame({ id: 'incomplete' }, new Uint8Array([1, 2, 3]));
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first, 0);
    combined.set(second, first.byteLength);

    const reassembler = new FrameReassembler();
    // Feed everything but the last 2 bytes of the second frame.
    const frames1 = reassembler.push(combined.subarray(0, combined.byteLength - 2));
    expect(frames1).toHaveLength(1);
    expect(frames1[0].header.id).toBe('complete');

    const frames2 = reassembler.push(combined.subarray(combined.byteLength - 2));
    expect(frames2).toHaveLength(1);
    expect(frames2[0].header.id).toBe('incomplete');
  });
});
