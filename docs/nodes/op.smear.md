---
title: Smear
node: op.smear
group: modifier
summary: "The scanner head stalled: sample one row or column and repeat it across the frame."
---

# Smear

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
The scanner head stalled: sample one row or column and repeat it across the frame.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Direction | h, v | h | h repeats a sampled column sideways; v repeats a sampled row up and down. |
| Mode | forward, both, backward | forward | Which side of the sampled line is overwritten: forward (right or down), backward (left or up), or both (the whole frame). |
| Position | 0 to 1, or more | 0.5 | Where the sampled column or row sits, from 0 (left or top) to 1 (right or bottom). |
| Keep silhouette | on or off | off | Only recolours pixels that are already visible, so the shape's outline does not change. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
