---
title: Text layer
node: text
group: layer
summary: Typed words in any installed font, which can also mask other layers.
---

# Text layer

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Typed words in any installed font, which can also mask other layers.

| Control | Range | Default | What it does |
|---|---|---|---|
| Name | text | empty | What the layer is called in the layer list. |
| State | active, locked | active | A locked layer can't be moved, scaled or rotated; its look can still change. |
| Output | image, mask, transform, data | image | What the layer hands on: its picture, a mask for other layers, a transform, or data. |
| Visible | on or off | on | Shows or hides the layer on the canvas. |
| Blend mode | normal, multiply, screen, overlay, darken, lighten, difference | normal | How the layer's colours mix with the layers beneath it. |
| Opacity | 0 to 1 | 1 | How solid the layer is, from fully see-through (0) to fully solid (1). |
| Position | x, y | 0, 0 px | Where the layer sits, as a shift in document pixels. |
| Scale | x, y | 1, 1 | How much the layer is stretched across and down; 1 is its own size. |
| Rotation | any | 0 rad | How far the layer is turned around its own centre. |
| Transform | 16 numbers | 16 numbers | A full transform handed on to other layers when the output is a transform. |
| Content | text | empty | The words the layer shows. |
| Font | structured | {"category":"","family":"","italic":false,"postscriptName":"","style":"","weight":0.0} | Which typeface the words are set in. |
| Size | any | 72 px | How tall the letters are. |
| Tracking | any | 0 | Opens up or tightens the space between every letter, in thousandths of an em. |
| Kerning | 0 to 200 | 100 | How much of the font's own pair spacing is used; 100 is as the font intends. |
| Line height | any | 1.2 | The space between lines, as a multiple of the font size. |
| Align | left, center, right | left | Which edge the lines of text line up against. |
| Fill | structured | empty | The colour inside the letters; empty leaves them unfilled. |
| Stroke | structured | empty | An outline around the letters, with its own colour and width. |
| Text origin | structured | {"x":0.0,"y":0.0} | Where the text starts on the canvas. |

References: `cameraId`.

A binding from it carries:

| Control | Range | Default | What it does |
|---|---|---|---|
| Mask layer | text | empty | Which layer shapes the mask. |
| Feather | any | 0 px | Softens the mask's edge so the effect fades in. |
| Expand | any | 0 px | Grows the masked area outwards, or shrinks it when negative. |
| Invert | on or off | off | Swaps the masked and unmasked areas. |
| Space | structured | empty | Whether the mask stays fixed on the document or travels with the layer. |
| Attached transform | structured | empty | Where the mask sits relative to the layer when it travels with it. |
<!-- generated:end -->

## What it's for
