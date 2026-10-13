---
title: Xerox
node: op.xerox
group: modifier
summary: "Copy-of-a-copy generation loss: contrast blowout, threshold drift, skew, toner speckle."
---

# Xerox

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Copy-of-a-copy generation loss: contrast blowout, threshold drift, skew, toner speckle.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Generations | 1 to 10, or more | 3 | Number of copy-of-a-copy passes. More passes mean harsher contrast and more drift. |
| Skew | 0 to 2, or more | 0.3 | Largest random tilt per pass, in degrees. 0 keeps the page straight. |
| Toner speckle | 0 to 1, or more | 0.15 | Amount of pale specks scattered through dark areas. Higher is more speckled; 0 is none. |
| Edge glow | 0 to 1, or more | 0.1 | Strength of the soft halo around edges. Higher is brighter; 0 is none. |
| Edge glow radius | 0.5 to 16, or more | 3 | Blur radius of the edge halo, in document pixels. Larger is a softer halo. |
| Keep colour | on or off | off | Leaves the image in colour instead of converting it to greyscale first. |
| Seed | 0 to 2147483647, or more | 0 | Changes the random pattern without changing its character. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
