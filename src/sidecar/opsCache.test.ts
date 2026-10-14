import { describe, expect, it } from 'vitest';
import { deriveOpLabel, type OpDescriptor, opLabel } from './opsCache';

describe('deriveOpLabel', () => {
  it('title-cases snake_case names', () => {
    expect(deriveOpLabel('gaussian_blur')).toBe('Gaussian Blur');
    expect(deriveOpLabel('invert')).toBe('Invert');
    expect(deriveOpLabel('colour_crush')).toBe('Colour Crush');
  });

  it('upper-cases known acronym tokens, matching the sidecar default_label', () => {
    expect(deriveOpLabel('cmyk_halftone')).toBe('CMYK Halftone');
    expect(deriveOpLabel('dla')).toBe('DLA');
    expect(deriveOpLabel('dla_growth')).toBe('DLA Growth');
  });
});

function descriptor(overrides: Partial<OpDescriptor> = {}): OpDescriptor {
  return {
    name: 'gaussian_blur',
    backend: 'python',
    params: [],
    ...overrides,
  };
}

describe('opLabel', () => {
  it("uses the descriptor's own label when present", () => {
    expect(opLabel(descriptor({ label: 'Gaussian Blur' }))).toBe('Gaussian Blur');
  });

  it('falls back to a derived label when the descriptor has none (older sidecar)', () => {
    expect(opLabel(descriptor({ name: 'cmyk_halftone', label: undefined }))).toBe('CMYK Halftone');
  });
});

describe('search-by-label filtering', () => {
  const ops: OpDescriptor[] = [
    descriptor({ name: 'xerox', label: 'Copy of a Copy' }),
    descriptor({ name: 'cmyk_halftone', label: 'CMYK Halftone' }),
    descriptor({ name: 'invert', label: 'Invert' }),
  ];

  function filterByQuery(query: string): OpDescriptor[] {
    const q = query.trim().toLowerCase();
    if (!q) return ops;
    return ops.filter(
      (op) => op.name.toLowerCase().includes(q) || opLabel(op).toLowerCase().includes(q),
    );
  }

  it('matches on the internal name', () => {
    expect(filterByQuery('xerox').map((o) => o.name)).toEqual(['xerox']);
  });

  it('matches on the label even when it differs from the name', () => {
    expect(filterByQuery('cmyk').map((o) => o.name)).toEqual(['cmyk_halftone']);
    expect(filterByQuery('halftone').map((o) => o.name)).toEqual(['cmyk_halftone']);
  });

  it('is case-insensitive', () => {
    expect(filterByQuery('XEROX').map((o) => o.name)).toEqual(['xerox']);
  });
});
