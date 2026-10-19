import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-dom/server reads zustand's *initial* state, so the off case needs the hook stood in for.
const toggle = vi.hoisted(() => ({ enabled: true }));
vi.mock('../selectionFillState', async (importActual) => ({
  ...(await importActual<typeof import('../selectionFillState')>()),
  useSelectionFillStore: <T,>(select: (s: { enabled: boolean }) => T) =>
    select({ enabled: toggle.enabled }),
}));

import { EllipseMarquee } from './EllipseMarquee';
import { LassoMarquee } from './LassoMarquee';
import { RectMarquee } from './RectMarquee';

const toDoc = (x: number, y: number) => ({ x, y });
const rect = { x: 10, y: 20, w: 100, h: 50 };

/** The fill paths in the markup, and where the first one sits relative to the outline. */
function fills(html: string): string[] {
  return html.match(/<path[^>]*data-selection-fill[^>]*>/g) ?? [];
}

beforeEach(() => {
  toggle.enabled = true;
});

describe('marquee selection fill (selection-fill-overlay.md)', () => {
  it('rect: a fill path under the outline, ignoring the pointer', () => {
    const html = renderToStaticMarkup(<RectMarquee rect={rect} viewScale={1} toDoc={toDoc} />);
    const [fill] = fills(html);
    expect(fills(html)).toHaveLength(1);
    expect(fill).toContain('d="M10,20 L110,20 L110,70 L10,70 Z"');
    expect(fill).toContain('pointer-events:none');
    expect(html.indexOf('data-selection-fill')).toBeLessThan(html.indexOf('<polygon'));
  });

  it('ellipse: a fill path under the outline, ignoring the pointer', () => {
    const html = renderToStaticMarkup(<EllipseMarquee rect={rect} viewScale={1} toDoc={toDoc} />);
    const [fill] = fills(html);
    expect(fills(html)).toHaveLength(1);
    expect(fill).toContain('A50,25');
    expect(fill).toContain('pointer-events:none');
    expect(html.indexOf('data-selection-fill')).toBeLessThan(html.indexOf('<ellipse'));
  });

  it('lasso: the fill is closed, even while still being drawn', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const open = renderToStaticMarkup(
      <LassoMarquee points={points} closed={false} viewScale={1} toDoc={toDoc} />,
    );
    const [fill] = fills(open);
    expect(fill).toContain('d="M0,0 L10,0 L10,10 Z"');
    expect(fill).toContain('pointer-events:none');
    // The outline stays open mid-draw; only the fill closes.
    expect(open).toContain('data-testid="lasso-marquee" d="M0,0 L10,0 L10,10"');
    expect(open.indexOf('data-selection-fill')).toBeLessThan(open.indexOf('lasso-marquee'));
    const closed = renderToStaticMarkup(
      <LassoMarquee points={points} closed viewScale={1} toDoc={toDoc} />,
    );
    expect(fills(closed)[0]).toContain('Z"');
  });

  it('draws no fill while the toggle is off, and keeps the outline', () => {
    toggle.enabled = false;
    const rectHtml = renderToStaticMarkup(<RectMarquee rect={rect} viewScale={1} toDoc={toDoc} />);
    const ellipseHtml = renderToStaticMarkup(
      <EllipseMarquee rect={rect} viewScale={1} toDoc={toDoc} />,
    );
    const lassoHtml = renderToStaticMarkup(
      <LassoMarquee
        points={[
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ]}
        closed={false}
        viewScale={1}
        toDoc={toDoc}
      />,
    );
    for (const html of [rectHtml, ellipseHtml, lassoHtml]) {
      expect(html).not.toContain('data-selection-fill');
      expect(html).toContain('stroke="#38bdf8"');
    }
  });
});
