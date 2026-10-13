---
title: Pixel layer
node: pixel
group: layer
summary: A picture, such as a photo you've opened.
---

# Pixel layer

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
A picture, such as a photo you've opened.

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
| Source size | x, y | 0, 0 px | The width and height of the picture the layer shows. |

References: `cameraId`, `source`.
<!-- generated:end -->

## What it's for

A pixel layer holds a picture: a photo or scan you opened, or an image dropped onto the window. It is the usual starting point for a document. The first one you open sets the size of the document.

**Modifiers.** Effects sit on the layer in a stack and run from the bottom row to the top. Each one changes the picture the one below it produced, so the order matters: Grain then Threshold turns the noise into speckled shapes, while Threshold then Grain leaves clean shapes with noise on top. Every modifier has an Enabled switch that turns it off without losing its settings.

**Masks on a modifier.** A modifier can apply to part of the picture. Pick a vector or text layer as its mask, or make one from a selection. Feather softens the edge, Expand grows or shrinks the area, and Invert swaps it. Vector and text layers have the details.

**Moving and locking.** Position, Scale and Rotation move the layer without recooking it. Setting State to locked bakes the layer at full size and freezes it: its modifiers and its position can't change, while opacity, blend mode and visibility still can. Unlocking makes the layer editable again.

**If the file moves.** If the picture's file is missing when the document opens, the layer stays in the stack with a striped placeholder. It is never deleted.
