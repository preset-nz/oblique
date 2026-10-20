import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-dom/server reads zustand's *initial* state, so the off case needs the hook stood in for.
const toggle = vi.hoisted(() => ({ enabled: true }));
vi.mock('./selectionFillState', async (importActual) => ({
  ...(await importActual<typeof import('./selectionFillState')>()),
  useSelectionFillStore: <T,>(select: (s: { enabled: boolean }) => T) =>
    select({ enabled: toggle.enabled }),
}));

import { featherSigma, paramsChangeFill, SelectionFill } from './SelectionFill';

beforeEach(() => {
  toggle.enabled = true;
});

describe('SelectionFill', () => {
  it('draws a translucent path in the outline colour that ignores the pointer', () => {
    const html = renderToStaticMarkup(<SelectionFill d="M0,0 L1,0 L1,1 Z" />);
    expect(html).toContain('<path');
    expect(html).toContain('d="M0,0 L1,0 L1,1 Z"');
    expect(html).toContain('fill="#38bdf8"');
    expect(html).toContain('fill-opacity="0.18"');
    expect(html).toContain('fill-rule="nonzero"');
    expect(html).toContain('pointer-events:none');
  });

  it('passes the fill rule through', () => {
    expect(renderToStaticMarkup(<SelectionFill d="M0,0 Z" fillRule="evenodd" />)).toContain(
      'fill-rule="evenodd"',
    );
  });

  it('draws nothing while the toggle is off', () => {
    toggle.enabled = false;
    expect(renderToStaticMarkup(<SelectionFill d="M0,0 Z" />)).toBe('');
  });
});

describe('SelectionFill params (selection-fill-params.md)', () => {
  const d = 'M10,10 L50,10 L50,40 Z';
  const doc: [number, number] = [200, 100];
  const plain = { featherPx: 0, expand: 0, invert: false };
  const render = (params: Partial<typeof plain>, fillRule?: 'evenodd') =>
    renderToStaticMarkup(
      <SelectionFill
        d={d}
        fillRule={fillRule}
        params={{ ...plain, ...params }}
        documentSize={doc}
      />,
    );

  it('renders the raw path while every param is at its default', () => {
    const html = render({});
    expect(html).toMatch(/^<path /);
    expect(html).not.toContain('<filter');
    expect(html).not.toContain('<mask');
    expect(html).not.toContain('<clipPath');
  });

  it('ignores a feather that rounds to under a pixel, as the rasteriser does', () => {
    expect(paramsChangeFill({ ...plain, featherPx: 0.4 })).toBe(false);
    expect(render({ featherPx: 0.4 })).toMatch(/^<path /);
    expect(featherSigma(0.5)).toBe(0.5);
  });

  it('invert tints the document rectangle through a mask that subtracts the shape', () => {
    const html = render({ invert: true });
    expect(html).toContain('<rect x="0" y="0" width="200" height="100" fill="#38bdf8" mask="url(#');
    // The shape sits inside the mask, drawn black.
    const mask = html.match(/<mask[\s\S]*?<\/mask>/)?.[0] ?? '';
    expect(mask).toContain(`d="${d}" fill="#000"`);
    expect(html).not.toMatch(/<path[^>]*fill="#38bdf8"/);
  });

  it('invert keeps the shape out of the tint for evenodd holes too', () => {
    expect(render({ invert: true }, 'evenodd')).toContain('fill-rule="evenodd"');
  });

  it('clips to the document bounds, and applies the 18% once to the group', () => {
    const html = render({ invert: true });
    expect(html).toContain('<clipPath');
    expect(html).toMatch(/<clipPath id="sf[^"]*"><rect x="0" y="0" width="200" height="100">/);
    expect(html).toMatch(/<g data-selection-fill="" opacity="0.18" clip-path="url\(#/);
    expect(html).toContain('pointer-events:none');
  });

  it('feather blurs the shape by sigma = featherPx, and more feather blurs more', () => {
    const sigmas = [3, 12].map((featherPx) => {
      const html = render({ featherPx });
      expect(html).toContain('<filter');
      expect(html).toMatch(/<g filter="url\(#/);
      return Number(html.match(/stdDeviation="([\d.]+)"/)?.[1]);
    });
    expect(sigmas).toEqual([3, 12]);
  });

  it('feather reaches far enough past the document for the blur not to clip', () => {
    const html = render({ featherPx: 10 });
    expect(html).toContain('x="-41" y="-41" width="282" height="182"');
  });

  it('positive expand strokes the outline at twice the offset with round joins', () => {
    const html = render({ expand: 6 });
    expect(html).toContain('stroke-width="12"');
    expect(html).toContain('stroke-linejoin="round"');
    expect(html).toContain('stroke-linecap="round"');
    expect(html).toContain('fill="#38bdf8"');
    expect(html).not.toContain('<mask');
  });

  it('negative expand cuts the same stroke out of the fill through a mask', () => {
    const html = render({ expand: -4 });
    const mask = html.match(/<mask[\s\S]*?<\/mask>/)?.[0] ?? '';
    expect(mask).toContain('stroke="#000"');
    expect(mask).toContain('stroke-width="8"');
    expect(html).toMatch(/<g mask="url\(#/);
    // The coloured shape carries no stroke of its own.
    expect(html).not.toMatch(/<path[^>]*fill="none"[^>]*stroke="#38bdf8"/);
  });

  it('applies the layers in the rasteriser order: expand inside feather, invert outside both', () => {
    const html = render({ expand: 3, featherPx: 5, invert: true });
    const m = html.match(/<mask id="[^"]*inv"[\s\S]*?<\/mask>/)?.[0] ?? '';
    expect(m.indexOf('filter=')).toBeGreaterThan(-1);
    expect(m.indexOf('filter=')).toBeLessThan(m.indexOf('stroke-width="6"'));
    // Fill first, then the stroke that grows it, both under the blur.
    expect(m.indexOf('d="M10')).toBeLessThan(m.indexOf('stroke-width="6"'));
  });

  it('draws nothing while the toggle is off, params or not', () => {
    toggle.enabled = false;
    expect(render({ invert: true, featherPx: 4, expand: 2 })).toBe('');
  });

  it('falls back to the raw path when the document has no size', () => {
    const html = renderToStaticMarkup(
      <SelectionFill d={d} params={{ ...plain, invert: true }} documentSize={[0, 0]} />,
    );
    expect(html).toMatch(/^<path /);
  });
});
