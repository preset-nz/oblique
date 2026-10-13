---
title: Film stock
node: op.film_stock
group: modifier
summary: "Grades the picture like a named film stock: tone curves with lifted blacks, a colour cross-mix, split-toned shadows and highlights, a vignette and grain."
---

# Film stock

<!-- generated:begin — rhizome-docs rewrites this block; write outside it -->
Grades the picture like a named film stock: tone curves with lifted blacks, a colour cross-mix, split-toned shadows and highlights, a vignette and grain.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Stock | polaroid_600, sx70, cross_process, bleach_bypass, expired | polaroid_600 | polaroid_600: milky lifted blacks, cyan-green shadows, warm creamy highlights, low contrast. sx70: warmer and more faded, with amber highlights and brown shadows. cross_process: slide film in the wrong chemistry, with hard contrast, blue shadows and yellow-green highlights. bleach_bypass: silver left in, so the colour is mostly gone and the contrast is hard and metallic. expired: faded old stock with a seeded colour shift and a magenta or cyan cast. |
| Amount | 0 to 1, or more | 1 | How much of the stock's colour grade is mixed in. 0 leaves the colours as they were; 1 is the full stock. Vignette and grain have their own sliders. |
| Grain | 0 to 1, or more | 0.5 | Film grain, as a share of the stock's own. 1 is the stock's full grain; 0 is none. The specks keep the same size relative to the picture at any resolution. |
| Vignette | 0 to 1, or more | 0.5 | Edge darkening, as a share of the stock's own. 1 is the stock's full vignette; 0 is none. It follows the frame, so it looks the same at any resolution. |
| Seed | 0 to 2147483647, or more | 0 | Changes the grain pattern and, for expired, the colour shift and which cast it gets. |

Slots: `mask`.
<!-- generated:end -->

## What it's for
