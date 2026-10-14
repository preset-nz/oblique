---
title: Document
node: document
group: document
summary: "The canvas everything is built on: its size, background and notes."
---

# Document

<!-- generated:begin — preset-docs rewrites this block; write outside it -->
The canvas everything is built on: its size, background and notes.

| Control | Range | Default | What it does |
|---|---|---|---|
| Scene id | text | empty | An internal id for the document; you never need to change it. |
| Size | x, y | 0, 0 px | The width and height of the canvas. |
| Resolution | draft, working, baked | working | How much detail is shown while you work: draft is quickest, baked is full size. |
| Note | text | empty | Free text kept with the document. |
| Background | structured | empty | What sits behind every layer: a flat colour or an image. |

References: `defaultCameraId`.
<!-- generated:end -->

## Using it

The document is the page the layers sit on. It has a size, a background and a note, and it decides what Export writes.

**Size** is the canvas in pixels. The first picture you open sets it to that picture's size; after that you can change it, with a choice of aspect ratios and an orientation. Layers keep their own size and are drawn from the top-left corner of the canvas. Nothing is stretched to fit, so a layer larger than the canvas runs off it and a smaller one leaves the rest of the canvas showing what is beneath.

**Background** is what sits behind every layer: a flat colour or a picture. It is always the lowest thing in the composite. It cannot be reordered, given a blend mode or deleted by accident, and a mask never clips it. A background picture is drawn at its own size from the top-left, like a layer.

**Resolution** is the detail level the document is worked at: draft is an eighth of full size, working is half, baked is full size. While you drag a control the canvas shows a quick draft, then sharpens to working once you stop. Ops measured in document pixels scale with the level, so the picture keeps the same shape at each. Export always writes at full size.

**Note** is free text that is saved with the document. It is not part of the picture.

**How the layers combine.** The top of the layer list is the top of the stack. Each layer is drawn with its blend mode and opacity, then the next one up. A layer set to output a mask draws nothing itself. It clips everything below it, up to the next mask layer or the bottom of the stack.
