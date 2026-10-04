// Bundles the API (including workspace TypeScript packages) into dist/ and
// copies the SQL migrations next to the bundle for the readiness check.
import { cpSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: {
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    'cli/staff': 'src/cli/staff.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Self-contained bundle: workspace packages and their dependencies are
  // included, because pnpm's isolated layout does not expose a workspace
  // package's dependencies to the app that imports it.
  external: ['pg-native'],
  banner: {
    // Lets bundled CommonJS dependencies call require() inside an ES module.
    js: "import { createRequire as __captainCreateRequire } from 'node:module'; const require = __captainCreateRequire(import.meta.url);",
  },
});
cpSync('../../packages/db/migrations', 'dist/migrations', { recursive: true });
console.log('api: built dist/server.js');
