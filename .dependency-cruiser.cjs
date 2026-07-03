/**
 * Layer-boundary enforcement — see design/architecture.md §Layer boundaries
 * in the guidance repo (source of truth; transcribed here, not invented).
 * Wired into `just check` as a build-failing gate.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make the dependency graph impossible to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Modules nothing imports yet — expected noise early in a layer\'s life (e.g. src/scene ' +
        'before anything consumes it); warn, not error.',
      from: { orphan: true, pathNot: '\\.(test|spec)\\.[jt]sx?$' },
      to: {},
    },
    {
      name: 'scene-is-the-bottom',
      severity: 'error',
      comment:
        'src/scene/ is the model — it must not know about rendering, cooking, panels, the ' +
        'sidecar, or app wiring.',
      from: { path: '^src/scene/' },
      to: { path: '^src/(canvas|compositor|cook|panels|sidecar|app)/' },
    },
    {
      name: 'engine-does-not-know-ui',
      severity: 'error',
      comment: 'src/compositor/ and src/cook/ are engine layers; they never import UI.',
      from: { path: '^src/(compositor|cook)/' },
      to: { path: '^src/(panels|app)/' },
    },
    {
      name: 'panels-canvas-meet-via-stores',
      severity: 'error',
      comment: 'src/panels/ and src/canvas/ never import each other directly.',
      from: { path: '^src/panels/' },
      to: { path: '^src/canvas/' },
    },
    {
      name: 'canvas-panels-meet-via-stores',
      severity: 'error',
      comment: 'src/panels/ and src/canvas/ never import each other directly.',
      from: { path: '^src/canvas/' },
      to: { path: '^src/panels/' },
    },
    {
      name: 'tauri-frame-ipc-only-via-sidecar-transport',
      severity: 'error',
      comment:
        'Nobody outside src/sidecar/tauriTransport.ts touches Tauri IPC for frames (as built, ' +
        'client.ts is transport-injected for testability).',
      from: { pathNot: '^src/sidecar/tauriTransport\\.ts$' },
      to: { path: 'node_modules/@tauri-apps/api' },
    },
    {
      name: 'ui-stays-dumb',
      severity: 'error',
      comment:
        'src/components/ui/ (generated shadcn) imports nothing from the model/engine/sidecar ' +
        'layers — it stays presentational.',
      from: { path: '^src/components/ui/' },
      to: { path: '^src/(scene|cook|compositor|sidecar)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
