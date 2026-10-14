---
title: Oblique nodes
---

# Oblique nodes

<!-- generated whole by preset-docs; write in the node pages, not here -->

## Colour

| | Node | What it does |
|---|---|---|
| ![Colour Crush](img/colour_crush-thumb.webp) | [Colour Crush](op.colour_crush.md) | Per-channel bit-depth reduction — posterise's meaner sibling, with optional Bayer dither. |
| ![Colour keep](img/colour_keep-thumb.webp) | [Colour keep](op.colour_keep.md) | Turn everything greyscale except the chosen colours. |
| ![Colourise](img/colourise-thumb.webp) | [Colourise](op.colourise.md) | Tint the image with a single ink, keeping the source luminance. |
| ![Desaturate](img/desaturate-thumb.webp) | [Desaturate](op.desaturate.md) | Blend the image toward Rec. 709 greyscale by a chosen amount. |
| ![Invert](img/invert-thumb.webp) | [Invert](op.invert.md) | Photographic negative of the RGB channels; alpha untouched. |
| ![Levels](img/levels-thumb.webp) | [Levels](op.levels.md) | Classic black/white/gamma tonal remap via a single LUT. |
| ![Recolour](img/recolour-thumb.webp) | [Recolour](op.recolour.md) | Remap luminance onto an ordered 2-4 colour ramp — the duotone/tritone workhorse. |

## Distort

| | Node | What it does |
|---|---|---|
| ![Gaussian Blur](img/gaussian_blur-thumb.webp) | [Gaussian Blur](op.gaussian_blur.md) | Even, soft blur across the RGB channels — alpha stays untouched. |
| ![Pixelate](img/pixelate-thumb.webp) | [Pixelate](op.pixelate.md) | Flat-mean square-cell mosaic — each cell renders as one solid colour. |
| ![Smear](img/smear-thumb.webp) | [Smear](op.smear.md) | The scanner head stalled: sample one row or column and repeat it across the frame. |

## Document

- [Document](document.md): The canvas everything is built on: its size, background and notes.

## Edges

| | Node | What it does |
|---|---|---|
| ![Dilate](img/dilate-thumb.webp) | [Dilate](op.dilate.md) | Grow the layer's shape outward, carrying its edge colour with it. |
| ![Edge Noise](img/edge_noise-thumb.webp) | [Edge Noise](op.edge_noise.md) | Tear and crumble the layer's edge — the interior stays solid. |
| ![Erode](img/erode-thumb.webp) | [Erode](op.erode.md) | Eat the layer's shape inward from its edge. |

## Film

| | Node | What it does |
|---|---|---|
| ![Bloom](img/bloom-thumb.webp) | [Bloom](op.bloom.md) | Bright areas bleed light into their surroundings. |
| ![Film Burn](img/film_burn-thumb.webp) | [Film Burn](op.film_burn.md) | The film stalls in the gate: a blister bubbles up, the emulsion chars, the image burns through. |
| ![Film stock](img/film_stock-thumb.webp) | [Film stock](op.film_stock.md) | Grades the picture like a named film stock: tone curves with lifted blacks, a colour cross-mix, split-toned shadows and highlights, a vignette and grain. |
| ![Grain](img/grain-thumb.webp) | [Grain](op.grain.md) | Seeded, chunky film-grain noise added to the RGB channels. |
| ![Dye Transfer](img/technicolor-thumb.webp) | [Dye Transfer](op.technicolor.md) | Dye-transfer colour from old three-strip and two-strip film: saturated reds, teal-cyans and slightly unreal skin, with the colour records printed a touch out of register. |

## Layer

- [Pixel layer](pixel.md): A picture, such as a photo you've opened.
- [Text layer](text.md): Typed words in any installed font, which can also mask other layers.
- [Vector layer](vector.md): Drawn shapes with smooth edges, which can also mask other layers.

## Print

| | Node | What it does |
|---|---|---|
| ![CMYK Halftone](img/cmyk_halftone-thumb.webp) | [CMYK Halftone](op.cmyk_halftone.md) | Prints the picture as the four dot screens of CMYK, at the classic angles, with optional misregistration and inks you can swap for spot-colour and riso looks. |
| ![Hatch](img/hatch-thumb.webp) | [Hatch](op.hatch.md) | Redraw tone as pen marks — hatched lines, dashes, crosses or stipple dots whose density follows the image's darkness. Layers stack crosshatch; one layer engraves. |
| ![Ink Starved](img/ink_starved-thumb.webp) | [Ink Starved](op.ink_starved.md) | The printer running dry: ink coverage fades along one axis, with worn-roller banding. |
| ![Threshold](img/threshold-thumb.webp) | [Threshold](op.threshold.md) | Hard (or smoothstepped) luminance cut to pure black and white. |
| ![Copy of a Copy](img/xerox-thumb.webp) | [Copy of a Copy](op.xerox.md) | Copy-of-a-copy generation loss: contrast blowout, threshold drift, skew, toner speckle. |
