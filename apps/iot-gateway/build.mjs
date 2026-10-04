import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
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
console.log('iot-gateway: built dist/main.js');
