import { describe, expect, it, vi } from 'vitest';
import type { VectorPath } from '@/scene/types';
import { frameFor } from '../selectShared/coords';
import {
  bufferToMaskPlane,
  OUTLINE_PROMPT_USES_MASK,
  type OutlinePromptDeps,
  outlineDocBox,
  outlineMaskFromDocPaths,
  resolveOutlineSeed,
  samEncoderScale,
} from './outlinePrompt';

function makeRasterize(impl: OutlinePromptDeps['rasterize']) {
  return vi.fn<OutlinePromptDeps['rasterize']>(impl);
}

describe('OUTLINE_PROMPT_USES_MASK', () => {
  it('is off by default (sidecar finding: box+mask localises worse than box-only)', () => {
    expect(OUTLINE_PROMPT_USES_MASK).toBe(false);
  });
});

describe('outlineDocBox', () => {
  it("returns the bounding box in DOCUMENT space — no frame, no mapping (state.ts's own contract)", () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 20, y: 10 } },
          { point: { x: 180, y: 10 } },
          { point: { x: 100, y: 90 } },
        ],
      },
    ];
    expect(outlineDocBox(paths)).toEqual({ x0: 20, y0: 10, x1: 180, y1: 90 });
  });

  it('returns undefined for an empty outline (nothing to seed from)', () => {
    expect(outlineDocBox([])).toBeUndefined();
  });
});

describe('resolveOutlineSeed', () => {
  it('returns box-only (mask: null) by default, in document space, without calling the rasteriser at all', () => {
    const frame = frameFor([200, 100], [100, 50]);
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [{ point: { x: 20, y: 10 } }, { point: { x: 180, y: 90 } }],
      },
    ];
    const rasterize = makeRasterize(() => new Uint8Array(256 * 256));

    const seed = resolveOutlineSeed(paths, 'nonzero', frame, { rasterize });

    expect(seed).toEqual({ box: { x0: 20, y0: 10, x1: 180, y1: 90 }, mask: null });
    expect(rasterize).not.toHaveBeenCalled();
  });

  it('returns undefined for an empty outline', () => {
    const frame = frameFor([200, 100], [100, 50]);
    expect(resolveOutlineSeed([], 'nonzero', frame)).toBeUndefined();
  });
});

describe('samEncoderScale (SAM preprocessing frame, sidecar dogfooding 2026-09-10)', () => {
  it('uses the LONGER side to reach 1024px — a non-square buffer gets ONE uniform scalar, not independent x/y factors', () => {
    // 2000x1000 buffer: longer side (2000) -> 1024, scale = 1024/2000 = 0.512.
    expect(samEncoderScale([2000, 1000])).toBeCloseTo(0.512, 10);
    // Same scale whichever axis is longer.
    expect(samEncoderScale([1000, 2000])).toBeCloseTo(0.512, 10);
  });

  it('a square buffer scales normally', () => {
    expect(samEncoderScale([512, 512])).toBeCloseTo(2, 10);
  });

  it('a zero-sized buffer scales to 0 rather than dividing by zero', () => {
    expect(samEncoderScale([0, 0])).toBe(0);
  });
});

describe('bufferToMaskPlane', () => {
  it('scales by the encoder scale / 4, top-left anchored (origin maps to origin)', () => {
    const bufferSize: [number, number] = [2000, 1000];
    expect(bufferToMaskPlane({ x: 0, y: 0 }, bufferSize)).toEqual({ x: 0, y: 0 });

    // scale = 0.512, /4 = 0.128.
    const p = bufferToMaskPlane({ x: 2000, y: 1000 }, bufferSize);
    expect(p.x).toBeCloseTo(2000 * 0.128, 10);
    expect(p.y).toBeCloseTo(1000 * 0.128, 10);
  });

  it('a non-square buffer lands its shorter axis short of 256 — padding on bottom/right, not a stretch to fill', () => {
    const bufferSize: [number, number] = [2000, 1000]; // 2:1 aspect
    const longEdge = bufferToMaskPlane({ x: 2000, y: 0 }, bufferSize);
    const shortEdge = bufferToMaskPlane({ x: 0, y: 1000 }, bufferSize);
    expect(longEdge.x).toBeCloseTo(256, 6); // the long side fills the mask plane exactly
    expect(shortEdge.y).toBeCloseTo(128, 6); // the short side only reaches half of it
  });
});

describe('outlineMaskFromDocPaths', () => {
  it('maps anchor points through docToBuffer then bufferToMaskPlane before rasterising, identity transform on the canvas side', () => {
    const frame = frameFor([2000, 1000], [1000, 500]); // factor 1/2, identity transform
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 2000, y: 1000 } }],
      },
    ];
    const rasterize = makeRasterize(() => new Uint8Array(256 * 256).fill(255));

    const mask = outlineMaskFromDocPaths(paths, 'nonzero', frame, { rasterize });

    expect(rasterize).toHaveBeenCalledTimes(1);
    const [calledPaths, fillRule] = rasterize.mock.calls[0];
    expect(fillRule).toBe('nonzero');
    // doc (0,0) -> buffer (0,0) -> mask-plane (0,0); doc (2000,1000) -> buffer
    // (1000,500) -> encoder scale 1024/1000=1.024, /4=0.256 -> (256, 128).
    expect(calledPaths[0].anchors[0].point).toEqual({ x: 0, y: 0 });
    expect(calledPaths[0].anchors[1].point.x).toBeCloseTo(256, 6);
    expect(calledPaths[0].anchors[1].point.y).toBeCloseTo(128, 6);
    expect(mask).toBe(rasterize.mock.results[0].value);
  });

  it('maps handleIn/handleOut alongside the anchor point', () => {
    const frame = frameFor([200, 100], [100, 50]);
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 }, handleIn: { x: 10, y: 0 }, handleOut: { x: 20, y: 0 } },
          { point: { x: 200, y: 100 } },
        ],
      },
    ];
    const rasterize = makeRasterize(() => new Uint8Array());
    outlineMaskFromDocPaths(paths, 'nonzero', frame, { rasterize });
    const [calledPaths] = rasterize.mock.calls[0];
    expect(calledPaths[0].anchors[0].handleIn).toBeDefined();
    expect(calledPaths[0].anchors[0].handleOut).toBeDefined();
  });
});
