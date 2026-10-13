---
title: Threshold
node: op.threshold
group: modifier
summary: Hard (or smoothstepped) luminance cut to pure black and white.
---

# Threshold

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Hard (or smoothstepped) luminance cut to pure black and white.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Level | 0 to 255, or more | 127 | Luminance cut-off, 0 to 255. Pixels at or above it turn white and the rest black, so higher gives more black. |
| Softness | 0 to 64, or more | 0 | Width of the soft transition around the level, in luminance steps. 0 is a hard cut. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
