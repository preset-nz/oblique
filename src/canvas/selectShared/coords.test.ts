import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM_2D } from '@/scene/types';
import {
  bufferBoundingBox,
  bufferPolygonsToDoc,
  bufferToDoc,
  docBoxToBufferBox,
  docPointsToBuffer,
  docToBuffer,
  frameFor,
} from './coords';

describe('smartSelect coords: document <-> cooked-buffer mapping', () => {
  it('identity transform, factor 1/2: document point halves into buffer space', () => {
    const frame = frameFor([200, 100], [100, 50]); // working-res factor, exact
    expect(docToBuffer({ x: 40, y: 20 }, frame)).toEqual({ x: 20, y: 10 });
  });

  it('bufferToDoc is the exact inverse of docToBuffer for the same frame', () => {
    const frame = frameFor([200, 100], [100, 50], {
      ...IDENTITY_TRANSFORM_2D,
      x: 30,
      y: -10,
      scaleX: 1.5,
      scaleY: 0.8,
      rotation: 0.3,
    });
    const doc = { x: 123.4, y: 56.7 };
    const buf = docToBuffer(doc, frame);
    const roundTrip = bufferToDoc(buf, frame);
    expect(roundTrip.x).toBeCloseTo(doc.x, 6);
    expect(roundTrip.y).toBeCloseTo(doc.y, 6);
  });

  it('derives the effective factor from the actual bitmap size, not a nominal 1/2 — odd source sizes round asymmetrically', () => {
    // computeTargetSize rounds w/h independently: a 101x101 source at
    // factor 0.5 rounds to 51x51 (not 50.5), an effective factor of
    // 51/101, not exactly 0.5.
    const frame = frameFor([101, 101], [51, 51]);
    const buf = docToBuffer({ x: 101, y: 101 }, frame);
    expect(buf.x).toBeCloseTo(51, 6);
    expect(buf.y).toBeCloseTo(51, 6);
  });

  it('a translated node: document points shift by the transform before scaling', () => {
    const frame = frameFor([200, 100], [100, 50], { ...IDENTITY_TRANSFORM_2D, x: 20, y: 10 });
    // docToLocalMatrix maps around the node's placed centre — check the
    // node's own local origin round-trips back to its placed position.
    const localOrigin = bufferToDoc({ x: 0, y: 0 }, frame);
    expect(docToBuffer(localOrigin, frame)).toEqual({ x: 0, y: 0 });
  });

  it('docPointsToBuffer / bufferPolygonsToDoc map arrays pointwise', () => {
    const frame = frameFor([200, 100], [100, 50]);
    const points = [
      { x: 0, y: 0 },
      { x: 200, y: 100 },
    ];
    expect(docPointsToBuffer(points, frame)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ]);

    const polygons = [[{ x: 0, y: 0 }], [{ x: 100, y: 50 }]];
    expect(bufferPolygonsToDoc(polygons, frame)).toEqual([[{ x: 0, y: 0 }], [{ x: 200, y: 100 }]]);
  });

  it('bufferBoundingBox: axis-aligned min/max over the mapped points, null for no points', () => {
    const frame = frameFor([200, 100], [100, 50]);
    const points = [
      { x: 20, y: 10 },
      { x: 180, y: 90 },
      { x: 40, y: 80 },
    ];
    expect(bufferBoundingBox(points, frame)).toEqual({ x0: 10, y0: 5, x1: 90, y1: 45 });
    expect(bufferBoundingBox([], frame)).toBeNull();
  });

  it('docBoxToBufferBox: maps a document-space box to its buffer-pixel bounding box', () => {
    const frame = frameFor([200, 100], [100, 50]);
    expect(docBoxToBufferBox({ x0: 20, y0: 10, x1: 180, y1: 90 }, frame)).toEqual({
      x0: 10,
      y0: 5,
      x1: 90,
      y1: 45,
    });
  });

  it('docBoxToBufferBox stays axis-aligned in buffer space even under a rotated node transform', () => {
    const frame = frameFor([200, 100], [100, 50], {
      ...IDENTITY_TRANSFORM_2D,
      rotation: Math.PI / 4,
    });
    const box = docBoxToBufferBox({ x0: 20, y0: 10, x1: 180, y1: 90 }, frame);
    expect(box.x0).toBeLessThanOrEqual(box.x1);
    expect(box.y0).toBeLessThanOrEqual(box.y1);
  });
});
