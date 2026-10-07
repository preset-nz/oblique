# Oblique — Claude instructions

Local-first image editor built around a modifier stack. Tauri 2 + React 19 + TypeScript + Tailwind v4 + @preset.nz/ux-kit (Base UI, Phosphor) + Zustand; Python sidecar (uv, NumPy + Pillow) for image ops.

## Where the truth lives

- **Design & plans:** `~/rhizomatic-preset/guidance/projects/oblique/` — NOT in this repo.
  - `design/architecture.md` — locked decisions (Canvas 2D compositor, sidecar frame protocol, backend-tagged ops, dirty rules, no DB). Read it before implementing anything; do not re-litigate locked decisions in code.
  - `features/NN-*/` — epics and feature stories. Work is story-driven: implement exactly one story's scope against its acceptance criteria.
- This repo holds code and code-near explainers only. Planning docs never land here.

## Workflow

Family rules (one story per commit, `just check`, subagents don't commit) are in `../CLAUDE.md`.

- Story docs' "Components touched" file paths are contractual.

## Hard rules

- Op parameter metadata lives in the op's home backend (Python or Rust) — TypeScript never hardcodes param schemas; the UI is generated from `list_ops`.
- Ops are pure and deterministic, RGBA8 same-size in/out, input never mutated.
- The scene object stays JSON-serialisable — no ImageBitmap or handles in the Zustand scene; caches live in the separate cache map.
- All overlay/geometry coordinates are document space; screen space exists only at pointer-event and paint edges via the shared `viewTransform`.
- Pointer Events API only — no mouse/touch handlers anywhere.

## Naming

The product name may still change. In `tauri.conf.json` it is `productName`, the window title, and the `.oblique` document type name in `fileAssociations`.
