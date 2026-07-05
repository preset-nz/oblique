import { describe, expect, it } from 'vitest';
import type { VectorPath } from './types';
import { type PathCommand, pathCommandsFor } from './vectorRasterize';

// `rasterizeVector` itself needs OffscreenCanvas/Path2D (browser-only), so
// this suite covers the pure command derivation only — the one place this
// module's own code could introduce non-determinism (Path2D's fill given
// identical commands is deterministic by browser contract; that's not this
// module's to re-prove). Byte-identical-plane and evenodd-hole behaviour
// aren't headlessly verifiable here — see the story report.

describe('pathCommandsFor', () => {
  it('a triangle of corner anchors: moveTo + lineTo + lineTo + closePath', () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 } },
          { point: { x: 10, y: 0 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands).toEqual<PathCommand[]>([
      { op: 'moveTo', to: { x: 0, y: 0 } },
      { op: 'lineTo', to: { x: 10, y: 0 } },
      { op: 'lineTo', to: { x: 5, y: 10 } },
      { op: 'lineTo', to: { x: 0, y: 0 } },
      { op: 'closePath' },
    ]);
  });

  it('an anchor with a handle draws a cubic segment, using the anchor point as the missing control point', () => {
    const paths: VectorPath[] = [
      {
        closed: false,
        anchors: [
          { point: { x: 0, y: 0 }, handleOut: { x: 2, y: 2 } },
          { point: { x: 10, y: 0 }, handleIn: { x: 8, y: 2 } },
        ],
      },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands).toEqual<PathCommand[]>([
      { op: 'moveTo', to: { x: 0, y: 0 } },
      {
        op: 'bezierCurveTo',
        c1: { x: 2, y: 2 },
        c2: { x: 8, y: 2 },
        to: { x: 10, y: 0 },
      },
    ]);
  });

  it('an open path never gets a closing segment', () => {
    const paths: VectorPath[] = [
      {
        closed: false,
        anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 10, y: 0 } }],
      },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands).toEqual<PathCommand[]>([
      { op: 'moveTo', to: { x: 0, y: 0 } },
      { op: 'lineTo', to: { x: 10, y: 0 } },
    ]);
  });

  it('multiple paths each start their own moveTo (separate contours)', () => {
    const paths: VectorPath[] = [
      { closed: false, anchors: [{ point: { x: 0, y: 0 } }, { point: { x: 1, y: 1 } }] },
      { closed: false, anchors: [{ point: { x: 5, y: 5 } }, { point: { x: 6, y: 6 } }] },
    ];

    const commands = pathCommandsFor(paths);

    expect(commands.filter((c) => c.op === 'moveTo')).toHaveLength(2);
  });

  it('an empty path contributes no commands', () => {
    expect(pathCommandsFor([{ closed: true, anchors: [] }])).toEqual([]);
  });

  it('is deterministic: identical paths always produce an identical command list', () => {
    const paths: VectorPath[] = [
      {
        closed: true,
        anchors: [
          { point: { x: 0, y: 0 }, handleOut: { x: 2, y: 2 } },
          { point: { x: 10, y: 0 }, handleIn: { x: 8, y: -2 } },
          { point: { x: 5, y: 10 } },
        ],
      },
    ];

    expect(pathCommandsFor(paths)).toEqual(pathCommandsFor(paths));
  });
});
