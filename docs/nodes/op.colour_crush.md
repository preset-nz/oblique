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

Reduces each colour channel to a few evenly spaced levels. With fewer bits there are fewer values per channel, so smooth gradients break into flat bands and colours snap to a small set.

- **Bits** is how many bits each channel keeps, 1 to 8. At 8 nothing changes. At 3 each channel has 8 levels. At 1 each channel is either 0 or 255, so the picture has only eight colours.
- **Dither** replaces the flat bands with a fixed 4 by 4 dot pattern, so the lost gradation reads as texture. The pattern is the same every time and does not move with a seed.
- **Red bits, Green bits, Blue bits** override Bits for one channel. 0 means use Bits.

Alpha is untouched.

## Recipes

- **One-bit screen.** Colour Crush with Bits 1 and Dither on, after Desaturate at Amount 1. Grey areas become a regular pattern of black and white dots.
- **Green-heavy.** Bits 8, Red bits 3, Blue bits 2: the green stays smooth while red and blue band.
