/**
 * Framed-stdio protocol, TS side (see
 * guidance/projects/oblique/design/architecture.md
 * Section "Python sidecar protocol"):
 *
 *   [4 bytes u32 LE: header_len] [header_len bytes: UTF-8 JSON header] [payload bytes]
 *
 * Pure functions only — no Tauri here, so this module is unit-testable
 * without a webview.
 */

export interface Frame {
  header: Record<string, unknown>;
  payload: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a header + payload into one length-prefixed frame. */
export function encodeFrame(
  header: Record<string, unknown>,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const fullHeader = { ...header, payload_bytes: payload.byteLength };
  const headerBytes = textEncoder.encode(JSON.stringify(fullHeader));

  const out = new Uint8Array(4 + headerBytes.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, true);
  out.set(headerBytes, 4);
  out.set(payload, 4 + headerBytes.byteLength);
  return out;
}

/**
 * Attempt to decode one frame from the start of `buffer`.
 *
 * Returns `null` if `buffer` does not yet contain a complete frame (the
 * caller should wait for more bytes and retry) — this is what makes
 * frame reassembly across chunk boundaries possible.
 */
export function tryDecodeFrame(buffer: Uint8Array): { frame: Frame; bytesConsumed: number } | null {
  if (buffer.byteLength < 4) return null;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const headerLen = view.getUint32(0, true);
  if (buffer.byteLength < 4 + headerLen) return null;

  const headerBytes = buffer.subarray(4, 4 + headerLen);
  const header = JSON.parse(textDecoder.decode(headerBytes)) as Record<string, unknown>;

  const payloadBytes = typeof header.payload_bytes === 'number' ? header.payload_bytes : 0;
  const totalLen = 4 + headerLen + payloadBytes;
  if (buffer.byteLength < totalLen) return null;

  const payload = buffer.subarray(4 + headerLen, totalLen);
  return { frame: { header, payload }, bytesConsumed: totalLen };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Reassembles complete frames out of an arbitrarily-chunked byte stream.
 * Rust relays raw stdout chunks (it never parses headers), so this is
 * where the frame boundaries actually get found, TS-side.
 */
export class FrameReassembler {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  /** Feed in the next chunk; returns any frames that are now complete. */
  push(chunk: Uint8Array): Frame[] {
    this.buffer = concatBytes(this.buffer, chunk);

    const frames: Frame[] = [];
    for (;;) {
      const result = tryDecodeFrame(this.buffer);
      if (!result) break;
      frames.push(result.frame);
      this.buffer = this.buffer.subarray(result.bytesConsumed);
    }
    return frames;
  }
}
