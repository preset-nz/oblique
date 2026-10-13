---
title: Colour keep
node: op.colour_keep
group: modifier
summary: Turn everything greyscale except the chosen colours.
---

# Colour keep

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Turn everything greyscale except the chosen colours.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Keep colour | text | #d02020 | The colour to keep. Only its hue counts; pixels with a similar hue stay in colour. |
| Hue range | 0 to 180, or more | 20 | Half-width of the kept band, in degrees of hue. Higher keeps more shades around the colour; 180 keeps every hue. |
| Softness | 0 to 180, or more | 20 | Width of the fade past the band, in degrees of hue. Higher gives a gentler edge between colour and grey; 0 is a hard edge. |
| Amount | 0 to 1, or more | 1 | How grey everything outside the band goes. 0 leaves the image unchanged; 1 is full Rec. 709 greyscale. |
| Minimum saturation | 0 to 1, or more | 0.1 | How colourful a pixel must be to count as kept. Higher turns more dull, near-grey pixels grey; 0 lets every pixel through. |
| Second colour | on or off | off | Keeps a second colour as well. Turn on to use Keep colour 2 and Hue range 2. |
| Keep colour 2 | text | #2060d0 | The second colour to keep. Only its hue counts. |
| Hue range 2 | 0 to 180, or more | 20 | Half-width of the second kept band, in degrees of hue. Higher keeps more shades around the colour. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
