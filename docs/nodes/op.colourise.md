---
title: Colourise
node: op.colourise
group: modifier
summary: Tint the image with a single ink, keeping the source luminance.
---

# Colourise

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Tint the image with a single ink, keeping the source luminance.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Colour | text | #7a5c3a | The ink the image is tinted with. |
| Amount | 0 to 1, or more | 1 | Strength of the tint. 0 leaves the image unchanged; 1 is fully tinted. |
| Keep brightness | on or off | on | Rescales the tinted result so each pixel keeps its original brightness. Off gives a darker, classic tint. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
