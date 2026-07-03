# Oblique — Claude instructions

Local-first image editor built around a modifier stack. Tauri 2 + React 19 + TypeScript + Tailwind v4 + shadcn/ui + Zustand; Python sidecar (uv, NumPy + Pillow) for image ops.

## Where the truth lives

- **Design & plans:** `~/rhizomatic-preset/guidance/projects/oblique/` — NOT in this repo.
  - `design/architecture.md` — locked decisions (Canvas 2D compositor, sidecar frame protocol, backend-tagged ops, dirty rules, no DB). Read it before implementing anything; do not re-litigate locked decisions in code.
  - `features/NN-*/` — epics and feature stories. Work is story-driven: implement exactly one story's scope against its acceptance criteria.
- This repo holds code and code-near explainers only. Planning docs never land here.

## Workflow

- One story = one unit of work = one commit. Don't bundle stories.
- Story docs' "Components touched" file paths are contractual.
- Run `just check` before finishing any task; hooks (lefthook) enforce it on push. Never use `--no-verify` — if a hook is wrong, fix the hook.
- Justfile verbs are the standard surface: `prep, install, run, check, build` (+ `fmt`). Call `just <verb>`, not raw pnpm/cargo/uv, per `~/rhizomatic-preset/guidance/runbooks/justfile-conventions.md`.
- Subagents implement; the orchestrating session reviews and commits. If you are a subagent: do not commit.

## Hard rules

- Op parameter metadata lives in the op's home backend (Python or Rust) — TypeScript never hardcodes param schemas; the UI is generated from `list_ops`.
- Ops are pure and deterministic (seeded randomness only), RGBA8 same-size in/out, input never mutated.
- The scene object stays JSON-serialisable — no ImageBitmap or handles in the Zustand scene; caches live in the separate cache map.
- All overlay/geometry coordinates are document space; screen space exists only at pointer-event and paint edges via the shared `viewTransform`.
- Pointer Events API only — no mouse/touch handlers anywhere.

## Naming

The product name may still change. The display name exists in exactly two places: `src/branding.ts` (`PRODUCT_NAME`) and `src-tauri/tauri.conf.json` (`productName` + window title). Never hardcode "Oblique" in user-facing strings — import `PRODUCT_NAME`.

## Language

NZ English in user-facing strings (`colour`, `organisation`); identifiers, CSS properties, and platform spellings stay standard (`color`).
