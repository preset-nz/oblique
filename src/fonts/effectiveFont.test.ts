import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./fontsIpc', () => ({ listFonts: vi.fn(), textOutlines: vi.fn() }));

import { specFor } from '@/scene/textGeometryCache';
import type { TextNode } from '@/scene/types';
import { useFontCatalogueStore } from './catalogue';
import { effectiveFont, effectiveFontFor } from './effectiveFont';
import { BLACKLETTER_BOLD, INSTALLED } from './testFixtures';
import type { FontFace, FontRef } from './types';

const node = (font: FontRef): TextNode =>
  ({
    type: 'text',
    content: 'x',
    font,
    fontSize: 10,
    tracking: 0,
    kerning: 100,
    lineHeight: 1.2,
    align: 'left',
  }) as TextNode;

function setCatalogue(status: 'idle' | 'ready' | 'error', faces: FontFace[]) {
  useFontCatalogueStore.setState({
    status,
    faces,
    byPostscript: new Map(faces.map((f) => [f.postscriptName, f])),
    families: [],
  });
}

beforeEach(() => setCatalogue('idle', []));

describe('effectiveFontFor', () => {
  it('passes an installed font through', () => {
    setCatalogue('ready', INSTALLED);
    const wanted = { ...INSTALLED[1] };
    expect(effectiveFontFor(node(wanted))).toBe(wanted);
    expect(effectiveFontFor(node(wanted)).postscriptName).toBe('HelveticaNeue-Bold');
  });

  it("gives a missing font the matcher's pick (serif bold -> Times New Roman Bold)", () => {
    setCatalogue('ready', INSTALLED);
    const wanted = { ...BLACKLETTER_BOLD };
    const eff = effectiveFontFor(node(wanted));
    expect(eff.postscriptName).toBe('TimesNewRomanPS-BoldMT');
    // The node itself is untouched: substitution never rewrites the wanted font.
    expect(wanted).toEqual(BLACKLETTER_BOLD);
  });

  it('passes through with no usable catalogue (not ready, errored, or empty)', () => {
    const wanted = { ...BLACKLETTER_BOLD };
    expect(effectiveFontFor(node(wanted))).toBe(wanted);
    setCatalogue('error', []);
    expect(effectiveFontFor(node(wanted))).toBe(wanted);
    setCatalogue('ready', []);
    expect(effectiveFontFor(node(wanted))).toBe(wanted);
  });

  it('follows catalogue changes (the memo is per faces array)', () => {
    const wanted = { ...BLACKLETTER_BOLD };
    setCatalogue('ready', INSTALLED);
    expect(effectiveFontFor(node(wanted)).postscriptName).toBe('TimesNewRomanPS-BoldMT');
    setCatalogue('ready', [...INSTALLED, { ...wanted }]);
    expect(effectiveFontFor(node(wanted)).postscriptName).toBe('BlackletterGrim-Bold');
  });

  it('feeds the Rust spec: the geometry cache key uses the substitute', () => {
    setCatalogue('ready', INSTALLED);
    expect(specFor(node({ ...BLACKLETTER_BOLD })).postscriptName).toBe('TimesNewRomanPS-BoldMT');
  });
});

describe('effectiveFont (pure)', () => {
  it('works over an explicit catalogue view', () => {
    const view = {
      status: 'ready' as const,
      faces: INSTALLED,
      byPostscript: new Map(INSTALLED.map((f) => [f.postscriptName, f])),
    };
    expect(effectiveFont(BLACKLETTER_BOLD, view).family).toBe('Times New Roman');
    expect(effectiveFont(BLACKLETTER_BOLD, { ...view, status: 'loading' })).toBe(BLACKLETTER_BOLD);
  });
});
