---
title: Hatch
node: op.hatch
group: modifier
summary: Redraw tone as pen marks — hatched lines, dashes, crosses or stipple dots whose density follows the image's darkness. Layers stack crosshatch; one layer engraves.
---

# Hatch

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Redraw tone as pen marks — hatched lines, dashes, crosses or stipple dots whose density follows the image's darkness. Layers stack crosshatch; one layer engraves.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Pattern | lines, dashes, crosses, stipple | lines | Mark style: lines, dashes, crosses or stipple dots, with density following the image's darkness. |
| Layers | 1 to 4, or more | 2 | Number of crossing mark families, 1 to 4. More layers build darker tones by crosshatching; 1 varies stroke width instead. |
| Spacing | 2 to 96, or more | 8 | Distance between marks in document pixels. Larger is coarser. |
| Angle | 0 to 180, or more | 45 | Rotation of the marks in degrees. |
| Weight | 0.05 to 1, or more | 1 | Overall ink coverage. Lower is lighter; 1 lets black close to solid. |
| Pen width | 0.01 to 1, or more | 1 | Widest a stroke may get, as a fraction of a full-width stroke. Lower draws finer lines; below 1, black no longer fills solid. |
| Jitter | 0 to 1, or more | 0 | How far marks wander from their regular position, as a fraction of spacing. 0 is perfectly regular. |
| Cross size | 0.25 to 3, or more | 1 | Arm length of each cross relative to its cell. Larger arms reach into neighbouring cells. |
| Cross aspect | 1 to 4, or more | 1 | Stretches one arm of each cross longer than the other. 1 keeps them equal. |
| Tone source | luma, red, green, blue | luma | What the marks follow: luma (overall brightness), or only the red, green or blue channel. |
| Black point | 0 to 255, or more | 0 | Input value, 0 to 255, treated as full darkness. Raising it puts more ink in the shadows. |
| White point | 0 to 255, or more | 255 | Input value, 0 to 255, treated as full lightness. Lowering it clears more of the highlights. |
| Gamma | 0.1 to 5, or more | 1 | Tone curve for the marks. Above 1 lightens the midtones, so fewer marks; below 1 darkens them. |
| Ink colour | text | #000000 | Colour of the marks. |
| Paper colour | text | #ffffff | Colour between the marks. Not used when Paper is transparent is on. |
| Paper is transparent | on or off | off | Makes the area between marks transparent so they overprint the layers below. |
| Seed | 0 to 2147483647, or more | 0 | Changes the random pattern without changing its character. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
