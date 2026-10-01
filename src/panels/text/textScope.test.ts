import { PropertyPanel } from '@preset.nz/facets';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFontCatalogueStore } from '@/fonts/catalogue';
import { type FontFace, type FontRef, fontRefOf } from '@/fonts/types';
import '@/panels/stack/bootstrap';
import { useSceneStore } from '@/scene/store';
import type { TextNode } from '@/scene/types';
import { registerTextFieldRenderers } from './fontFieldRenderers';
import {
  clearRememberedColours,
  DEFAULT_STROKE,
  readTextValues,
  registerTextScope,
  TEXT_SCOPE_KEY,
  textPatchFor,
  textScope,
} from './textScope';

const face = (
  family: string,
  style: string,
  postscriptName: string,
  weight: number,
  italic = false,
): FontFace => ({ family, style, postscriptName, weight, italic, category: 'sans', latin: true });

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

const refOf = (f: FontFace): FontRef => fontRefOf(f);
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
  kerning: 100,
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
  const on = { color: '#112233', width: 4 };

  it('stroke.width is not writable while the stroke is disabled', () => {
    expect(textPatchFor(node(), 'stroke.width', 5, FACES)).toBeNull();
  });

  it('stroke.color (a colour) is ignored while the stroke is disabled; Enabled is the way on', () => {
    expect(textPatchFor(node(), 'stroke.color', '#ff0000', FACES)).toBeNull();
    expect(textPatchFor(node(), 'stroke.color', true, FACES)).toEqual({
      stroke: { color: DEFAULT_STROKE.color, width: DEFAULT_STROKE.width },
    });
  });

  it('enabling restores the remembered colour with the default width', () => {
    expect(textPatchFor(node(), 'stroke.color', true, FACES, { stroke: '#abcdef' })).toEqual({
      stroke: { color: '#abcdef', width: DEFAULT_STROKE.width },
    });
  });

  it('rebuilds the stroke object rather than mutating it', () => {
    const n = node({ stroke: on });
    const patch = textPatchFor(n, 'stroke.width', 9, FACES);
    expect(patch).toEqual({ stroke: { color: '#112233', width: 9 } });
    expect(patch?.stroke).not.toBe(on);
    expect(on).toEqual({ color: '#112233', width: 4 });
  });

  it('recolours an enabled stroke, and null switches it off', () => {
    expect(textPatchFor(node({ stroke: on }), 'stroke.color', '#ff0000', FACES)).toEqual({
      stroke: { color: '#ff0000', width: 4 },
    });
    expect(textPatchFor(node({ stroke: on }), 'stroke.color', null, FACES)).toEqual({
      stroke: null,
    });
  });
});

describe('fill enable', () => {
  it('true restores the remembered colour, else #ffffff', () => {
    expect(textPatchFor(node({ fill: null }), 'fill', true, FACES, { fill: '#ff8800' })).toEqual({
      fill: '#ff8800',
    });
    expect(textPatchFor(node({ fill: null }), 'fill', true, FACES)).toEqual({ fill: '#ffffff' });
  });
});

describe('enable/disable through the scope remembers the colour', () => {
  beforeEach(() => {
    clearRememberedColours();
    useFontCatalogueStore.setState({ status: 'idle', faces: [] });
  });

  const seed = (overrides: Partial<TextNode>) => {
    const n = node(overrides);
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [n] } }));
    return n.id;
  };
  const current = (id: string) =>
    useSceneStore.getState().scene.nodes.find((x) => x.id === id) as TextNode;
  const write = (id: string, path: string, value: unknown) =>
    textScope.write?.(path, value, { nodeId: id }, null);

  it('fill: disable then enable gives the old colour back', () => {
    const id = seed({ fill: '#336699' });
    write(id, 'fill', null);
    expect(current(id).fill).toBeNull();
    write(id, 'fill', true);
    expect(current(id).fill).toBe('#336699');
  });

  it('fill: enabling with nothing remembered gives #ffffff', () => {
    const id = seed({ fill: null });
    write(id, 'fill', true);
    expect(current(id).fill).toBe('#ffffff');
  });

  it('stroke: disable then enable restores colour, width resets to the default', () => {
    const id = seed({ stroke: { color: '#ff00ff', width: 7 } });
    write(id, 'stroke.color', null);
    expect(current(id).stroke).toBeNull();
    write(id, 'stroke.width', 9); // not writable while disabled
    expect(current(id).stroke).toBeNull();
    write(id, 'stroke.color', true);
    expect(current(id).stroke).toEqual({ color: '#ff00ff', width: DEFAULT_STROKE.width });
  });

  it('stroke: enabling with nothing remembered gives { #000000, 2 }', () => {
    const id = seed({ stroke: null });
    write(id, 'stroke.color', true);
    expect(current(id).stroke).toEqual({ color: '#000000', width: 2 });
  });
});

describe('Text panel rendering', () => {
  registerTextFieldRenderers();
  registerTextScope();

  const render = (n: TextNode) => {
    useSceneStore.setState((s) => ({ scene: { ...s.scene, nodes: [n] } }));
    return renderToStaticMarkup(
      createElement(PropertyPanel, {
        scopeKey: TEXT_SCOPE_KEY,
        selection: { nodeId: n.id },
        ctx: { nodeId: n.id, font: n.font },
      }),
    );
  };
  /** The `<input>` that follows a number field's label span, as markup. */
  const inputAfter = (markup: string, label: string) => {
    const start = markup.indexOf(`>${label}<`);
    if (start === -1) throw new Error(`no field ${label}`);
    const open = markup.indexOf('<input', start);
    return markup.slice(open, markup.indexOf('>', open));
  };

  it('Text is the first field, above Font', () => {
    const markup = render(node());
    expect(markup.indexOf('aria-label="Text"')).toBeGreaterThan(-1);
    expect(markup.indexOf('aria-label="Text"')).toBeLessThan(markup.indexOf('Font'));
    expect(markup).toContain('>Text<');
    expect(markup).toContain('>HI</textarea>');
  });

  it('stroke width is disabled while the stroke is off, live while it is on', () => {
    expect(inputAfter(render(node({ stroke: null })), 'Stroke width')).toContain('disabled=""');
    expect(
      inputAfter(render(node({ stroke: { color: '#000000', width: 2 } })), 'Stroke width'),
    ).not.toContain('disabled=""');
  });

  it('Fill and Stroke use "Enabled" checkboxes, never "None"', () => {
    const markup = render(node());
    expect(markup.match(/Enabled/g)).toHaveLength(2);
    expect(markup).not.toContain('None');
  });
});

describe('plain fields', () => {
  it('maps fill, kerning and align, and rejects nonsense', () => {
    expect(textPatchFor(node(), 'fill', null, FACES)).toEqual({ fill: null });
    expect(textPatchFor(node(), 'fill', '#abcdef', FACES)).toEqual({ fill: '#abcdef' });
    expect(textPatchFor(node(), 'kerning', 35, FACES)).toEqual({ kerning: 35 });
    expect(textPatchFor(node(), 'kerning', true, FACES)).toBeNull();
    expect(textPatchFor(node(), 'content', 'A\nB', FACES)).toEqual({ content: 'A\nB' });
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
    expect(textPatchFor(node(), 'kerning', 900, FACES)).toEqual({ kerning: 200 });
    expect(textPatchFor(node(), 'kerning', -5, FACES)).toEqual({ kerning: 0 });
    expect(
      textPatchFor(node({ stroke: { color: '#000000', width: 2 } }), 'stroke.width', 500, FACES),
    ).toEqual({ stroke: { color: '#000000', width: 200 } });
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
