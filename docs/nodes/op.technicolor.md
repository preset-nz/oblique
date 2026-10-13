---
title: Technicolor
node: op.technicolor
group: modifier
summary: "Dye-transfer colour from old three-strip and two-strip film: saturated reds, teal-cyans and slightly unreal skin, with the colour records printed a touch out of register."
---

# Technicolor

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Dye-transfer colour from old three-strip and two-strip film: saturated reds, teal-cyans and slightly unreal skin, with the colour records printed a touch out of register.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Process | two_strip, three_strip | three_strip | three_strip keeps red, green and blue records. two_strip has only red-orange and cyan-green records, so blues collapse toward cyan-green, as in the 1920s. |
| Dye density | 0 to 2, or more | 1.2 | How heavy the dyes are. Higher gives deeper, more saturated colour and darker shadows; 1 is a plain print and 0 is clear film (white). |
| Cross-talk | 0 to 1, or more | 0.25 | How much each dye bleeds into its neighbours. Higher softens colour separation and blends hues together; 0 keeps the dyes separate. |
| Fringe | 0 to 8, or more | 1.5 | Largest random shift of each colour record, in document pixels. Higher gives wider coloured halos on edges; 0 keeps the records aligned. |
| Amount | 0 to 1, or more | 0.8 | How much of the effect is mixed in. 0 leaves the image unchanged; 1 is the full dye-transfer result. |
| Seed | 0 to 2147483647, or more | 0 | Changes the direction each record shifts without changing the fringe width. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
