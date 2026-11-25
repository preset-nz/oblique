---
title: JPEG Corrupt
node: op.jpeg_corrupt
group: modifier
category: distort
summary: "The file rots: colonies of broken JPEG blocks spread through the picture."
thumbnail: img/jpeg_corrupt-thumb.webp
---

# JPEG Corrupt

<!-- generated:begin — preset-docs rewrites this block; write outside it -->
The file rots: colonies of broken JPEG blocks spread through the picture.

| Control | Range | Default | What it does |
|---|---|---|---|
| Enabled | on or off | on | Turns the effect on or off without losing its settings. |
| Progress | 0 to 1, or more | 0.35 | How much of the picture is infected. 0 leaves it untouched; 1 infects every block. |
| Colonies | 1 to 12, or more | 3 | How many places the infection starts from. |
| Spores | 0 to 1, or more | 0.15 | Share of blocks hit at random ahead of the colonies. |
| Irregularity | 0 to 1, or more | 0.6 | How ragged the edge of a colony is. |
| Smear | 1 to 64, or more | 4 | How many blocks one hit's damage can run on for, along the row. |
| Severity | 1 to 16, or more | 3 | Damaged bytes per infected run. More is more broken. |
| Damage | Flip bits (`flip`), Replace bytes (`replace`), Shift bytes (`shift`) | Shift bytes (`shift`) | What a hit does to the file: flip a byte's bits, replace a byte, or slip a byte in or out. |
| Quality | 5 to 95, or more | 40 | The JPEG quality the picture is saved at before it's damaged. |
| Colour blocks | Coarse (4:2:0) (`420`), Fine (4:4:4) (`444`) | Coarse (4:2:0) (`420`) | How coarse the colour is within a block. Coarse gives the chunky colour smears. |
| Block size | 4 to 128, or more | 16 | Size of one damaged block, in document pixels. |
| Show | Picture (`picture`), Damage (`damage`), Colonies (`colonies`) | Picture (`picture`) | The whole picture, only the broken blocks (the rest transparent), or a map of the infection. |
| Variant | 0 to 9999, or more | 0 | Re-rolls the damage inside infected blocks; the colonies stay where they are. |
| Seed | 0 to 9999, or more | 0 | Where the colonies and spores fall. |

Slots: `mask`.
<!-- generated:end -->

## Using it

Breaks the picture the way a damaged JPEG file breaks, and spreads the damage like an infection. The op saves the picture as a real JPEG, damages bytes inside the file and opens it again. Add it to a layer with **Add modifier**.

### To grow the infection

Drag **Progress** from 0 to 1. Each step only adds damage, so a sequence of frames reads as growth rather than flicker.

### To colour only the damage

1. Select the layer and choose **Edit ▸ Duplicate** (⌘D).
2. On the top copy, set **Show** to Damage.
3. On the top copy, add Desaturate, or another colour modifier, after JPEG Corrupt.

Only the broken blocks change colour; the rest of the picture shows through from the copy underneath.

**Note:** the two copies have their own settings. A change to Progress, Seed or any other setting on one copy moves its damage away from the other's, so make it on both.

### To see the colonies

Set **Show** to Colonies and drag **Progress**. White spreads through the grey as the infection does.

### Settings

- **Progress** Sets how much of the picture is infected. At 0 the picture is untouched; at 1 every block is infected. Blocks not yet reached keep their original pixels, so the JPEG's quality loss shows only where the infection has been. 0.35 by default.
- **Colonies** Sets how many places the infection starts from. Seed places them; at a given seed the first colony stays put as the count goes up.
- **Spores** Sets the share of blocks hit at random ahead of the colonies, as isolated blocks in front of the spread.
- **Irregularity** Sets how ragged a colony's edge is. At 0 each colony grows as a clean circle; higher reads as mould.
- **Smear** Sets how many blocks along a row one hit can damage. The damage stops at the end of its run, so 1 keeps each break to a single block and high values give long runs.
- **Severity** Sets how many bytes are damaged in each infected run.
- **Damage** Chooses what a hit does to the file. **Flip bits** changes a byte, **Replace bytes** puts a random byte in its place, and **Shift bytes** slips a byte in or out, which knocks the rest of the run out of step: the slips and the garbage colour.
- **Quality** Sets the JPEG quality the picture is saved at before it is damaged. Low is blocky and rough; high keeps more of the picture around the damage.
- **Colour blocks** Chooses how coarse the colour is. **Coarse (4:2:0)** keeps colour at half the detail of the grey, so a break smears colour across a larger block. **Fine (4:4:4)** keeps colour at full detail, so the breaks are smaller and sharper.
- **Block size** Sets the size of one damaged block in document pixels. The picture is scaled to fit the block grid before it is damaged and scaled back afterwards.
- **Show** Chooses what the op hands on. Picture by default.
  - **Picture** The whole picture with the damage in it. Alpha is kept.
  - **Damage** Only the broken blocks, with everything else transparent. A block counts as broken when the damage changed it, not merely when the infection reached it. With nothing broken (Progress 0, or a file that won't open) the layer is fully transparent.
  - **Colonies** A map of the infection, with no JPEG in it: white where it has reached, grey ahead of it, lighter for the blocks it reaches next and darker for the last. At Progress 0 the map is all grey. Quality, Severity, Damage and Variant don't change it.
- **Variant** Re-rolls the damage inside the infected blocks without moving the colonies. Stepping it gives a boiling look.
- **Seed** Moves the colonies and the spores.

When the damaged file won't open, the op tries once more with different damage. If that fails too, Picture hands the layer on unchanged.

## Recipes

- **Infection in progress.** The defaults, with Progress stepped from 0 to 1.
- **Rotting mainframe.** Progress 0.5, Colonies 4, Spores 0.2, Smear 8, Severity 6, Seed 11.
- **Grey rot.** Rotting mainframe on both copies, with the damage coloured by Desaturate, as in *To colour only the damage*.
- **Boiling.** Every setting held, with Variant stepped.
- **Fine corrosion.** Colour blocks Fine (4:4:4), Block size 8, Severity 8, Damage Replace bytes.

## Examples

<!-- examples:begin — `just examples` rewrites this block; write outside it -->
![JPEG Corrupt at its defaults](img/jpeg_corrupt-defaults.webp)

*Defaults.*

![JPEG Corrupt, "Rotting mainframe": Progress 0.5, Colonies 4, Spores 0.2, Smear 8, Severity 6, Seed 11](img/jpeg_corrupt-recipe.webp)

*Rotting mainframe: JPEG Corrupt (Progress 0.5, Colonies 4, Spores 0.2, Smear 8, Severity 6, Seed 11).*
<!-- examples:end -->
