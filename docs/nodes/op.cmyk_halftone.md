---
title: CMYK Halftone
node: op.cmyk_halftone
group: modifier
summary: "Screen-printed CMYK dot raster: classic screen angles, optional seeded misregistration, and swappable ink colours for spot-ink and riso looks. `white_is_alpha` makes the paper transparent (in mode='paper' only) so the dots overprint the layers below. `spill` (with white_is_alpha, paper mode) samples the dots from the layer's tone over paper instead of cutting them to its silhouette, so dots complete themselves past the edge."
---

# CMYK Halftone

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Screen-printed CMYK dot raster: classic screen angles, optional seeded misregistration, and swappable ink colours for spot-ink and riso looks. `white_is_alpha` makes the paper transparent (in mode='paper' only) so the dots overprint the layers below. `spill` (with white_is_alpha, paper mode) samples the dots from the layer's tone over paper instead of cutting them to its silhouette, so dots complete themselves past the edge.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Dot size | 1 to 200, or more | 6 | Spacing between dot centres in document pixels. Larger is coarser dots. |
| Cyan angle | 0 to 90, or more | 15 | Rotation of the cyan dot screen in degrees. |
| Magenta angle | 0 to 90, or more | 75 | Rotation of the magenta dot screen in degrees. |
| Yellow angle | 0 to 90, or more | 0 | Rotation of the yellow dot screen in degrees. |
| Black angle | 0 to 90, or more | 45 | Rotation of the black dot screen in degrees. |
| Cyan ink | text | #00ffff | Colour the cyan plate is printed in. |
| Magenta ink | text | #ff00ff | Colour the magenta plate is printed in. |
| Yellow ink | text | #ffff00 | Colour the yellow plate is printed in. |
| Black ink | text | #000000 | Colour the black plate is printed in. |
| Misregistration | 0 to 8, or more | 0 | Largest random shift of each ink plate, in document pixels. 0 keeps the plates aligned. |
| Seed | 0 to 2147483647, or more | 0 | Changes the random pattern without changing its character. |
| Mode | paper, over | paper | paper prints the dots on white paper; over prints them on top of the original image. |
| Paper is transparent | on or off | off | Makes the paper transparent so the dots overprint the layers below. Paper mode only. |
| Dots past edge | on or off | off | Samples the dots from the layer's tone over paper, so they carry on past its edge. Needs Paper is transparent, in paper mode. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
