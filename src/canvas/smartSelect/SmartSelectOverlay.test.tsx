import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-dom/server reads zustand's *initial* state, so the off case needs the hook stood in for.
const toggle = vi.hoisted(() => ({ enabled: true }));
vi.mock('../selectionFillState', async (importActual) => ({
  ...(await importActual<typeof import('../selectionFillState')>()),
  useSelectionFillStore: <T,>(select: (s: { enabled: boolean }) => T) =>
    select({ enabled: toggle.enabled }),
}));

import { SmartSelectOverlay } from './SmartSelectOverlay';

const outer = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];
const hole = [
  { x: 40, y: 40 },
  { x: 60, y: 40 },
  { x: 60, y: 60 },
];

function fills(html: string): string[] {
  return html.match(/<path[^>]*data-selection-fill[^>]*>/g) ?? [];
}

beforeEach(() => {
  toggle.enabled = true;
});

describe('SmartSelectOverlay selection fill (selection-fill-overlay.md)', () => {
  it('fills every contour in one evenodd path that ignores the pointer', () => {
    const html = renderToStaticMarkup(
      <SmartSelectOverlay points={[]} box={null} polygons={[outer, hole]} viewScale={1} />,
    );
    const found = fills(html);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('fill-rule="evenodd"');
    expect(found[0]).toContain('pointer-events:none');
    expect(found[0]).toContain('M0,0 L100,0 L100,100 L0,100 Z M40,40 L60,40 L60,60 Z');
    expect(html.indexOf('data-selection-fill')).toBeLessThan(html.indexOf('stroke-dasharray'));
  });

  it('draws no fill with no polygons', () => {
    const html = renderToStaticMarkup(
      <SmartSelectOverlay points={[]} box={null} polygons={[]} viewScale={1} />,
    );
    expect(fills(html)).toHaveLength(0);
  });

  it('draws no fill while the toggle is off, and keeps the outline', () => {
    toggle.enabled = false;
    const html = renderToStaticMarkup(
      <SmartSelectOverlay points={[]} box={null} polygons={[outer]} viewScale={1} />,
    );
    expect(html).not.toContain('data-selection-fill');
    expect(html).toContain('stroke="#38bdf8"');
  });
});
