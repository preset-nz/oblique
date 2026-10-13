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

A vector layer is a shape drawn with the pen tool: closed or open paths made of points and curve handles. You can edit any point afterwards and everything that depends on the shape updates. It exists to be a shape, a stencil or a mask.

**A vector layer has no colour of its own.** It draws as flat white on transparent. To make the shape a colour, add Colourise with Keep brightness off, or Recolour. To give Hatch or CMYK Halftone anything to work with, give the shape a tone first; on plain white they have nothing to read.

**Fill rule** decides what happens where outlines overlap. Non-zero fills the inside of overlapping outlines solid when they run the same way round. Even-odd alternates filled and empty at each outline, so a circle drawn inside a circle becomes a ring.

**As a mask for the layers below.** Set Output to mask and the shape clips every layer beneath it, up to the next mask layer or the bottom of the stack. Layers above it are untouched. A mask layer reads only its alpha. Modifiers on the mask layer therefore matter only if they change alpha: Dilate, Erode and Edge Noise reshape the clip, as do Bloom with Glow past edge on and Smear. Gaussian Blur changes only colour and does not feather the edge. This applies when the layer is a mask layer. When the shape masks a single modifier on another layer, the mask is built from the shape's paths, so modifiers on the vector layer do not change it; the controls below do.

**As a mask for one modifier.** On any layer, pick the vector layer as a modifier's mask and that modifier applies only inside the shape. Edit a point and the masked result updates. One shape can mask many modifiers, each with its own settings in the binding:

- **Feather** softens the edge of the mask so the effect fades in. This is how you soften a mask's edge.
- **Expand** grows the masked area, or shrinks it when negative.
- **Invert** swaps inside and outside.
- **Space** is whether the mask is fixed on the document or travels with the layer it masks. Fixed, moving the layer slides it under the mask. Travelling, they move together. A mask made from a selection travels by default; a mask made from a vector layer is fixed.

Deleting the vector layer removes its masks from the modifiers that used them, and they apply everywhere again.
