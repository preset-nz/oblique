---
title: Vector layer
node: vector
group: layer
summary: Drawn shapes with smooth edges, which can also mask other layers.
---

# Vector layer

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Drawn shapes with smooth edges, which can also mask other layers.

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
| Paths | structured | empty | The outlines that make up the shape, point by point. |
| Fill rule | nonzero, evenodd | nonzero | How overlapping outlines fill: non-zero fills them all, even-odd leaves holes where they cross. |

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
