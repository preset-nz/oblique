---
title: Text layer
node: text
group: layer
summary: Typed words in any installed font, which can also mask other layers.
---

# Text layer

<!-- generated:begin — preset-docs rewrites this block; write outside it -->
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

## Using it

A text layer is words set in any font installed on the computer, placed on the canvas with the T tool. Click where the first line sits, then type the words in the inspector's Text field; edit them there at any time. Each line break is one you type. There is no box and no wrapping.

**What you set.** The font is chosen by family and one of its own named styles, such as Bold Condensed or Light Italic. Size is in document pixels. Tracking opens or tightens the space between every letter. Kerning scales the font's built-in pair spacing: 100 is as the font intends, 0 is none, 200 is double. Line height is a multiple of the size. Fill is the colour inside the letters and Stroke an outline of its own width, painted over the fill and centred on the edge. Align sets which edge the lines line up against.

**As an image.** The layer is a picture of the letters on a transparent ground, and takes modifiers like any other layer. Grain and Xerox rough it up. Dilate and Erode thicken and thin it, and Edge Noise frays the outlines, because there is an edge to work on. Ops that read tone, such as Hatch, see the Fill colour, so set it to the shade you want.

**As a mask for the layers below.** Set Output to mask and the letters clip everything beneath them, up to the next mask layer. For a mask the Fill and Stroke colours do not matter, only where they cover. Modifiers on the text layer reshape that mask only when the layer is a mask layer; they do not change it when the text masks a single modifier elsewhere.

**As a mask for one modifier.** Pick the text layer as a modifier's mask and that modifier applies only inside the letters: Grain only inside the word. The mask follows the words, the font and the position as they change. Here the mask is the glyph shapes alone: the Stroke does not widen it. Use Expand for a fatter or thinner mask. The binding has the same controls as on a vector layer:

- **Feather** softens the edge so the effect fades in.
- **Expand** grows the masked area, or shrinks it when negative.
- **Invert** swaps inside and outside.
- **Space** is whether the mask is fixed on the document or travels with the layer it masks.

**If the font is missing.** Opening a document on a computer without the font gives one warning that lists each substitute. The layer is drawn in the closest installed font, and the layer remembers the font it wanted, so installing it and reopening brings it back. Type → Replace Font… makes a swap permanent for the document.

**Convert to Outlines.** Type → Convert to Outlines turns the layer into a vector layer in the same place in the stack. The letterforms become points you can edit. Modifiers, mask role and position stay; Fill and Stroke colour do not carry across. It is one-way, and undo restores the live text.
