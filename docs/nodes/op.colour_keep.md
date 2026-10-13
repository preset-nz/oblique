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

Everything goes grey except colours near the one you pick. Pixels inside the band keep their colour; the rest are pulled toward their Rec. 709 grey.

Only the hue of **Keep colour** counts. Its brightness and saturation are ignored, so a pale pink and a deep red keep the same pixels. A grey swatch has no hue and counts as red.

- **Hue range** is the half-width of the kept band in degrees around the hue. At 20 it keeps shades close to the colour; at 180 it keeps every hue.
- **Softness** is how many degrees past the band the colour fades out. At 0 the edge between colour and grey is hard, which shows as a ragged line where hues drift.
- **Amount** is how grey the rest goes. 1 is full greyscale, 0 changes nothing.
- **Minimum saturation** stops dull pixels counting as kept. A near-grey pixel has no real hue, and a dark shadow's hue is noise, so a reddish shadow would otherwise stay red. Pixels below half of this value are never kept and the ones between half and the full value fade in. Raise it if grey areas near the colour keep a tint; set 0 to let every pixel through.
- **Second colour** adds a second band with its own Keep colour 2 and Hue range 2. Softness and Minimum saturation are shared. The two bands are unioned: a pixel keeps whichever of them keeps more.

Alpha is untouched.

## Recipes

- **Red coat.** Colour keep with Keep colour a mid red, Hue range 15, Softness 10 and Minimum saturation 0.2, then Grain at Amount 0.1.
- **Two spots.** Turn on Second colour and keep red and blue, with Amount 0.9 so the rest holds a trace of colour.
