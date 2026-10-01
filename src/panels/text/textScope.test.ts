import { describe, expect, it } from 'vitest';
import type { FontFace, FontRef } from '@/fonts/types';
import type { TextNode } from '@/scene/types';
import { DEFAULT_STROKE, readTextValues, textPatchFor } from './textScope';

const face = (
  family: string,
  style: string,
  postscriptName: string,
  weight: number,
  italic = false,
): FontFace => ({ family, style, postscriptName, weight, italic, category: 'sans' });

const FACES: FontFace[] = [
  face('Helvetica Neue', 'Light', 'HelveticaNeue-Light', 300),
  face('Helvetica Neue', 'Regular', 'HelveticaNeue', 400),
  face('Helvetica Neue', 'Bold', 'HelveticaNeue-Bold', 700),
  face('Helvetica Neue', 'Condensed Bold', 'HelveticaNeue-CondensedBold', 700),
  face('Georgia', 'Regular', 'Georgia', 400),
  face('Georgia', 'Bold', 'Georgia-Bold', 700),
  face('Georgia', 'Italic', 'Georgia-Italic', 400, true),
  face('Plain Sans', 'Book', 'PlainSans-Book', 400),
  face('Plain Sans', 'Heavy', 'PlainSans-Heavy', 800),
];

const refOf = (f: FontFace): FontRef => ({ ...f });
const ps = (name: string): FontFace => {
  const f = FACES.find((x) => x.postscriptName === name);
  if (!f) throw new Error(name);
  return f;
};

const node = (overrides: Partial<TextNode> = {}): TextNode => ({
  id: 't',
  label: 'T',
  type: 'text',
  state: 'active',
  output: 'image',
  cameraId: null,
  modifiers: [],
  visible: true,
  blendMode: 'normal',
  opacity: 1,
  dirty: { draft: false, working: false },
  content: 'HI',
  font: refOf(ps('HelveticaNeue-Bold')),
  fontSize: 72,
  tracking: 0,
  kerning: true,
  lineHeight: 1.2,
  align: 'left',
  fill: '#ffffff',
  stroke: null,
  position: { x: 0, y: 0 },
  ...overrides,
});

describe('choosing a family keeps the nearest style', () => {
  it('Bold -> Bold when the new family has it', () => {
    const patch = textPatchFor(node(), 'font.family', 'Georgia', FACES);
    expect(patch?.font?.postscriptName).toBe('Georgia-Bold');
    // The whole FontRef is written.
    expect(patch?.font).toEqual(refOf(ps('Georgia-Bold')));
  });

  it('keeps Condensed Bold over Bold when both share a weight (resolveFont alone would pick by PostScript name)', () => {
    const condensed = node({
      font: refOf(face('Other', 'Condensed Bold', 'Other-CondensedBold', 700)),
    });
    expect(textPatchFor(condensed, 'font.family', 'Helvetica Neue', FACES)?.font?.style).toBe(
      'Condensed Bold',
    );
    const bold = node({ font: refOf(face('Other', 'Bold', 'Other-Bold', 700)) });
    expect(textPatchFor(bold, 'font.family', 'Helvetica Neue', FACES)?.font?.style).toBe('Bold');
  });

  it('falls back to the nearest weight when the style name is absent', () => {
    // Plain Sans has no "Bold": Heavy (800) is nearer to 700 than Book (400).
    const patch = textPatchFor(node(), 'font.family', 'Plain Sans', FACES);
    expect(patch?.font?.postscriptName).toBe('PlainSans-Heavy');
  });

  it('keeps italic where the family has an italic face of nearest weight', () => {
    const italic = node({ font: refOf(face('Helvetica Neue', 'Oblique', 'X-Oblique', 400, true)) });
    expect(textPatchFor(italic, 'font.family', 'Georgia', FACES)?.font?.postscriptName).toBe(
      'Georgia-Italic',
    );
  });

  it('is null for a family that is not installed', () => {
    expect(textPatchFor(node(), 'font.family', 'Nope', FACES)).toBeNull();
  });
});

describe('font.style', () => {
  it('writes the whole FontRef of the chosen face (by PostScript name), within the node family', () => {
    const patch = textPatchFor(node(), 'font.style', 'HelveticaNeue-CondensedBold', FACES);
    expect(patch).toEqual({ font: refOf(ps('HelveticaNeue-CondensedBold')) });
  });

  it('rejects a face from a different family', () => {
    expect(textPatchFor(node(), 'font.style', 'Georgia-Bold', FACES)).toBeNull();
  });
});

describe('stroke', () => {
  it('stroke.width with stroke null turns it on with the default colour', () => {
    expect(textPatchFor(node(), 'stroke.width', 5, FACES)).toEqual({
      stroke: { color: DEFAULT_STROKE.color, width: 5 },
    });
  });

  it('stroke.color with stroke null turns it on with the default width', () => {
    expect(textPatchFor(node(), 'stroke.color', '#ff0000', FACES)).toEqual({
      stroke: { color: '#ff0000', width: DEFAULT_STROKE.width },
    });
  });

  it('rebuilds the stroke object rather than mutating it', () => {
    const stroke = { color: '#112233', width: 4 };
    const n = node({ stroke });
    const patch = textPatchFor(n, 'stroke.width', 9, FACES);
    expect(patch).toEqual({ stroke: { color: '#112233', width: 9 } });
    expect(patch?.stroke).not.toBe(stroke);
    expect(stroke).toEqual({ color: '#112233', width: 4 });
  });

  it('stroke.color null switches the stroke off', () => {
    expect(
      textPatchFor(node({ stroke: { color: '#000000', width: 2 } }), 'stroke.color', null, FACES),
    ).toEqual({
      stroke: null,
    });
  });
});

describe('plain fields', () => {
  it('maps fill, kerning and align, and rejects nonsense', () => {
    expect(textPatchFor(node(), 'fill', null, FACES)).toEqual({ fill: null });
    expect(textPatchFor(node(), 'fill', '#abcdef', FACES)).toEqual({ fill: '#abcdef' });
    expect(textPatchFor(node(), 'kerning', false, FACES)).toEqual({ kerning: false });
    expect(textPatchFor(node(), 'align', 'center', FACES)).toEqual({ align: 'center' });
    expect(textPatchFor(node(), 'align', 'justify', FACES)).toBeNull();
    expect(textPatchFor(node(), 'fontSize', Number.NaN, FACES)).toBeNull();
    expect(textPatchFor(node(), 'nope', 1, FACES)).toBeNull();
  });

  it('clamps numbers to the schema ranges (a typed value can exceed the field max)', () => {
    expect(textPatchFor(node(), 'fontSize', 99999, FACES)).toEqual({ fontSize: 2000 });
    expect(textPatchFor(node(), 'fontSize', 0, FACES)).toEqual({ fontSize: 1 });
    expect(textPatchFor(node(), 'tracking', -9000, FACES)).toEqual({ tracking: -500 });
    expect(textPatchFor(node(), 'lineHeight', 0.1, FACES)).toEqual({ lineHeight: 0.5 });
    expect(textPatchFor(node(), 'stroke.width', 500, FACES)).toEqual({
      stroke: { color: DEFAULT_STROKE.color, width: 200 },
    });
  });
});

describe('readTextValues', () => {
  it('flattens nested fields to dotted keys, with null/default stroke when off', () => {
    const v = readTextValues(node());
    expect(v['font.family']).toBe('Helvetica Neue');
    expect(v['font.style']).toBe('Bold');
    expect(v['stroke.color']).toBeNull();
    expect(v['stroke.width']).toBe(DEFAULT_STROKE.width);
    expect(readTextValues(node({ stroke: { color: '#123456', width: 7 } }))['stroke.width']).toBe(
      7,
    );
  });
});
