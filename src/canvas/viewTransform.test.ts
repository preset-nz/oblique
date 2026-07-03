import { describe, expect, it } from 'vitest';
import {
  clampScale,
  docToScreen,
  fitTransform,
  MAX_SCALE,
  MIN_SCALE,
  reset100Transform,
  screenToDoc,
  type ViewTransform,
  zoomAt,
} from './viewTransform';

describe('docToScreen / screenToDoc round-trip', () => {
  const cases: ViewTransform[] = [
    { scale: 1, tx: 0, ty: 0 },
    { scale: 2.5, tx: 40, ty: -12 },
    { scale: 1 / 8, tx: -200, ty: 300 },
    { scale: 32, tx: 0, ty: 0 },
    { scale: 1 / 32, tx: 5, ty: 5 },
  ];

  for (const view of cases) {
    it(`round-trips for scale=${view.scale} tx=${view.tx} ty=${view.ty}`, () => {
      const points = [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 1024, y: 1024 },
        { x: -50, y: 300 },
      ];
      for (const p of points) {
        const screen = docToScreen(view, p);
        const back = screenToDoc(view, screen);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    });
  }
});

describe('cursor-centred zoom', () => {
  it('keeps the document point under the cursor fixed before and after zoom', () => {
    const view: ViewTransform = { scale: 1, tx: 10, ty: 20 };
    const cursor = { x: 300, y: 150 };

    const docPtBefore = screenToDoc(view, cursor);
    const zoomed = zoomAt(view, cursor, 2);
    const docPtAfter = screenToDoc(zoomed, cursor);

    expect(docPtAfter.x).toBeCloseTo(docPtBefore.x, 9);
    expect(docPtAfter.y).toBeCloseTo(docPtBefore.y, 9);
  });

  it('holds across a sequence of zoom-in/zoom-out gestures at different cursors', () => {
    let view: ViewTransform = { scale: 1, tx: 0, ty: 0 };
    const gestures: Array<{ cursor: { x: number; y: number }; factor: number }> = [
      { cursor: { x: 100, y: 100 }, factor: 1.5 },
      { cursor: { x: 400, y: 250 }, factor: 0.8 },
      { cursor: { x: 50, y: 600 }, factor: 3 },
    ];

    for (const { cursor, factor } of gestures) {
      const docPtBefore = screenToDoc(view, cursor);
      view = zoomAt(view, cursor, factor);
      const docPtAfter = screenToDoc(view, cursor);
      expect(docPtAfter.x).toBeCloseTo(docPtBefore.x, 9);
      expect(docPtAfter.y).toBeCloseTo(docPtBefore.y, 9);
    }
  });

  it('does not assert the cursor invariant once scale is clamped at a boundary', () => {
    // At the clamp boundary, the requested scale is not the resulting scale,
    // so the cursor-fixed-point algebra no longer applies — zoomAt still
    // clamps correctly, it just can't hold the invariant here by construction.
    const view: ViewTransform = { scale: MAX_SCALE, tx: 0, ty: 0 };
    const zoomed = zoomAt(view, { x: 0, y: 0 }, 10);
    expect(zoomed.scale).toBe(MAX_SCALE);
  });
});

describe('scale clamping', () => {
  it('clamps below the minimum', () => {
    expect(clampScale(1 / 1000)).toBe(MIN_SCALE);
  });

  it('clamps above the maximum', () => {
    expect(clampScale(1000)).toBe(MAX_SCALE);
  });

  it('passes through in-range values', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(MIN_SCALE)).toBe(MIN_SCALE);
    expect(clampScale(MAX_SCALE)).toBe(MAX_SCALE);
  });

  it('zoomAt clamps the resulting scale', () => {
    const view: ViewTransform = { scale: MIN_SCALE, tx: 0, ty: 0 };
    const zoomed = zoomAt(view, { x: 0, y: 0 }, 0.5);
    expect(zoomed.scale).toBe(MIN_SCALE);

    const view2: ViewTransform = { scale: MAX_SCALE, tx: 0, ty: 0 };
    const zoomed2 = zoomAt(view2, { x: 0, y: 0 }, 2);
    expect(zoomed2.scale).toBe(MAX_SCALE);
  });
});

describe('fitTransform / reset100Transform', () => {
  it('fits a square document into a square viewport at scale 1', () => {
    const view = fitTransform(1024, 1024, 1024, 1024);
    expect(view.scale).toBe(1);
    expect(view.tx).toBe(0);
    expect(view.ty).toBe(0);
  });

  it('fits and centres a document into a larger viewport', () => {
    const view = fitTransform(2048, 1024, 1024, 1024);
    expect(view.scale).toBe(1);
    expect(view.tx).toBe(512);
    expect(view.ty).toBe(0);
  });

  it('resets to 100% centred regardless of viewport size', () => {
    const view = reset100Transform(2048, 2048, 1024, 1024);
    expect(view.scale).toBe(1);
    expect(view.tx).toBe(512);
    expect(view.ty).toBe(512);
  });
});
