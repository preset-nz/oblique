---
title: Bloom
node: op.bloom
group: modifier
summary: Bright areas bleed light into their surroundings.
---

# Bloom

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Bright areas bleed light into their surroundings.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Threshold | 0 to 1, or more | 0.7 | Brightness above which pixels glow, 0 to 1. Lower lets more of the image bloom. |
| Radius | 0 to 200, or more | 24 | How far the glow spreads, in document pixels. Larger is a wider, softer glow. |
| Intensity | 0 to 2, or more | 0.8 | Strength of the glow. Higher is brighter; 0 turns it off. |
| Blend | screen, add | screen | How the glow combines with the image: screen only lightens, add blows out to white faster. |
| Glow past edge | on or off | off | Lets the glow spread beyond the layer's edge into transparent areas. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
