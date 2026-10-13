---
title: Colour Crush
node: op.colour_crush
group: modifier
summary: Per-channel bit-depth reduction — posterise's meaner sibling, with optional Bayer dither.
---

# Colour Crush

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Per-channel bit-depth reduction — posterise's meaner sibling, with optional Bayer dither.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Bits | 1 to 8, or more | 3 | Bits kept per channel, 1 to 8. Fewer bits means fewer colours and harsher banding. |
| Dither | on or off | off | Breaks banding up with an ordered 4 by 4 dot pattern instead of flat steps. |
| Red bits | 0 to 8, or more | 0 | Bits kept for the red channel only. 0 uses Bits instead. |
| Green bits | 0 to 8, or more | 0 | Bits kept for the green channel only. 0 uses Bits instead. |
| Blue bits | 0 to 8, or more | 0 | Bits kept for the blue channel only. 0 uses Bits instead. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
