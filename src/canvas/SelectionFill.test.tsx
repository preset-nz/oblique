import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-dom/server reads zustand's *initial* state, so the off case needs the hook stood in for.
const toggle = vi.hoisted(() => ({ enabled: true }));
vi.mock('./selectionFillState', async (importActual) => ({
  ...(await importActual<typeof import('./selectionFillState')>()),
  useSelectionFillStore: <T,>(select: (s: { enabled: boolean }) => T) =>
    select({ enabled: toggle.enabled }),
}));

import { SelectionFill } from './SelectionFill';

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
