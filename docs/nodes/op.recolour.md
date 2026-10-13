---
title: Recolour
node: op.recolour
group: modifier
summary: Remap luminance onto an ordered 2-4 colour ramp — the duotone/tritone workhorse.
---

# Recolour

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Remap luminance onto an ordered 2-4 colour ramp — the duotone/tritone workhorse.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Stop 1 | text | #000000 | Colour for the darkest tones. |
| Stop 2 | text | #4a3f6b | Second colour in the ramp, dark to light. With 2 stops it is the lightest colour. |
| Stop 3 | text | #b06a4a | Third colour in the ramp. Used when Stops is 3 or 4; with 3 stops it is the lightest colour. |
| Stop 4 | text | #ffffff | Lightest colour in the ramp. Only used when Stops is 4. |
| Stops | 2 to 4, or more | 2 | How many ramp colours are used, 2 to 4. They are spaced evenly from dark to light. |
| Blend | 0 to 1, or more | 1 | How strongly the ramp replaces the original colours. 0 leaves the image unchanged; 1 is a full remap. |
| Keep brightness | on or off | off | Rescales the remapped colours so each pixel keeps its original brightness. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
