# Oblique

A grim-dark image editing tool built with Tauri, React, TypeScript, and Tailwind CSS.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Branding

The product name is defined in two places and must be kept in sync:

- `src/branding.ts` — the PRODUCT_NAME export used in React components
- `src-tauri/tauri.conf.json` — productName and window title used by Tauri

Update both when changing the display name.
