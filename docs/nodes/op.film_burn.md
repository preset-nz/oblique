---
title: Film Burn
node: op.film_burn
group: modifier
summary: "The film stalls in the gate: a blister bubbles up, the emulsion chars, the image burns through."
---

# Film Burn

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
The film stalls in the gate: a blister bubbles up, the emulsion chars, the image burns through.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Progress | 0 to 1, or more | 0 | How far the burn has spread. 0 leaves the image untouched; 1 burns the whole frame through. |
| Hot spots | 1 to 4, or more | 1 | Number of places the burn starts from. |
| Irregularity | 0 to 1, or more | 0.5 | How ragged the burn front is. 0 is a smooth circle; higher is more uneven. |
| Feature size | 1 to 128, or more | 24 | Size of the bumps in the burn front, in document pixels. Larger is a broader wobble. |
| Blister | 0 to 1, or more | 0.6 | How far the image bulges outward ahead of the burn. 0 is flat; higher pushes harder. |
| Char width | 0 to 1, or more | 0.4 | Width of the blister and scorched bands around the burn. Higher is a wider scorched edge. |
| Char colour | text | #2a1608 | Colour of the scorched band. |
| Burn-through | white, transparent | white | What the fully burnt area becomes: white, or transparent so layers below show through. |
| Seed | 0 to 2147483647, or more | 0 | Changes the random pattern without changing its character. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
