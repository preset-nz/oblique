---
title: Ink Starved
node: op.ink_starved
group: modifier
summary: "The printer running dry: ink coverage fades along one axis, with worn-roller banding."
---

# Ink Starved

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
The printer running dry: ink coverage fades along one axis, with worn-roller banding.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Direction | h, v | h | h fades the ink from left to right; v fades it from top to bottom. |
| Starvation | 0 to 1, or more | 0.4 | How much ink is lost by the far end, 0 to 1. Higher is paler. |
| Banding | 0 to 1, or more | 0.2 | Strength of the worn-roller stripes. Higher is stronger stripes; 0 is none. |
| Band spacing | 2 to 64, or more | 12 | Distance between stripes in document pixels. Larger is wider stripes. |
| Channel | all, c, m, y, k | all | Which ink runs dry: all of them, or only cyan (c), magenta (m), yellow (y) or black (k). |
| Seed | 0 to 2147483647, or more | 0 | Changes the random pattern without changing its character. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
