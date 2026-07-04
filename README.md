# Oblique

**An image editor for making things worse — beautifully.**

Most image software is built to perfect pictures: sharper, cleaner, more correct. Oblique points the other way. It's a desktop editor built around **disruption, fracture, and decay** — for images that look like they *survived something*: five generations of photocopying, a dying printer, a flooded archive, an underground print run that nobody proofread.

The target aesthetic is expressionistic, grim-dark TTRPG art — the world of MÖRK BORG zines, CY_BORG handouts, and Death in Space ephemera — where a lossy, imperfect, physically damaged image isn't a mistake. It's the point.

## How it works (the two-minute version)

You don't paint in Oblique. You **stack operators**.

Drop in a photo, a scan, a render. Then pile treatments onto it — a blur, a threshold, a CMYK silkscreen raster, film grain — and *scrub* their parameters while the canvas answers in real time. Every operator stays live and reorderable forever: nothing is baked in until you say so, and every knob can be revisited three weeks later. The same image can be pushed through *xerox hell*, starved of ink, crushed to a brutal palette, or eaten at the edges — and pulled back, because nothing was destroyed along the way.

Each operator is designed to represent **something that happened to the image**, not a graphics algorithm. Not "posterize" — a photocopier on its fifth generation. Not "noise" — toner speckle collecting in the shadows.

## Where it's going

- **A full stack of layers** — images, vector shapes, and text as peers, blending and masking each other, treated per-layer or all at once.
- **3D as raw material, not a mode switch** — drop in a low-poly model or a Gaussian splat of a real object, steal its silhouette, and abuse it like any other layer.
- **Print as a first-class destination** — silkscreen-style separations, registration drift, colour bars: output that looks like it came off a press with opinions.
- **Assisted vandalism** — paint roughly around a thing and let a model find its edges, so you can delete, mask, or corrupt *objects*, not pixels. None of it needs to be perfect. Perfect is the enemy.

## Status

Personal project, early and moving fast. The heart — live operator stacking on real images, with projects that save and reopen exactly as you left them — works today. Not published, not accepting contributions (yet); if you're seeing this over someone's shoulder: yes, it's supposed to look like that.

---

*Oblique — after Virilio's "oblique function": nothing here stands upright on purpose.*

## Developer notes

- Recipes: `just --list` (`just run`, `just check`). Full architecture and roadmap live in the guidance repo: `~/rhizomatic-preset/guidance/projects/oblique/`.
- IDE: [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
- Branding: the product name is defined in `src/branding.ts` (PRODUCT_NAME) **and** `src-tauri/tauri.conf.json` (productName/window title) — update both together.
