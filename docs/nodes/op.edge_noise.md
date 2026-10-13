---
title: Edge Noise
node: op.edge_noise
group: modifier
summary: Tear and crumble the layer's edge — the interior stays solid.
---

# Edge Noise

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Tear and crumble the layer's edge — the interior stays solid.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Amount | 0 to 1, or more | 0.4 | How far the edge is pushed around, as a proportion of Feature size. Higher is rougher; 0 does nothing. |
| Feature size | 1 to 128, or more | 12 | Size of the bumps along the edge, in document pixels. Larger is broader tears. |
| Seed | 0 to 2147483647, or more | 0 | Changes the random pattern without changing its character. |
| Profile | smooth, linear, saw, rect, straight | smooth | Shape of the tears: smooth curves, linear (polygonal), saw (sharp teeth), rect (square steps) or straight (long flat rips). |

Slots: `mask`.
<!-- generated:end -->

## What it's for
