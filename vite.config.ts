/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // The @preset.nz packages ship unbuilt TypeScript. Pin the shared runtime
    // to this app's copy; facets and the kit are in the list because two
    // copies would mean two registries (a temporary `pnpm link` makes that
    // easy to hit). See guidance/design/tauri-scaffold.md, "Consuming a
    // path-linked package".
    dedupe: [
      'react',
      'react-dom',
      '@tauri-apps/api',
      '@preset.nz/ux-kit',
      '@preset.nz/facets',
      '@preset.nz/app-kit',
    ],
  },

  test: {
    // ux-kit and app-kit are linked from packages/ (package.json), whose dependencies live in
    // that monorepo's own node_modules, with their own copy of React. Left alone, a test loads
    // two Reacts ("Cannot read properties of null (reading 'useMemo')"). The app build avoids
    // it with `dedupe` above; here, Vite processes those packages (`inline`) so `dedupe` applies,
    // except for the CommonJS `use-sync-external-store` shim that base-ui imports, which Vite
    // cannot process. That one is aliased to this app's copy (the devDependency is for this).
    alias: {
      'use-sync-external-store': path.resolve(__dirname, 'node_modules/use-sync-external-store'),
    },
    server: {
      deps: {
        inline: [/\/packages\/node_modules\//],
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1440,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1441,
        }
      : undefined,
    // The linked packages (ux-kit's fonts live in packages/node_modules) are outside this
    // project's root. Goes when Oblique is back on registry versions of ux-kit and app-kit.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(__dirname, '../../packages')],
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}));
