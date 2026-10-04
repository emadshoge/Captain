// Expo checks that run without an Expo account or native toolchain:
// 1. resolve the app config, 2. export JS bundles for Android and iOS.
// This does NOT prove a native build works; that needs an EAS build.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env, EXPO_NO_TELEMETRY: '1', CI: '1' };
const run = (args) =>
  execFileSync('pnpm', ['exec', 'expo', ...args], { stdio: 'pipe', env }).toString();

const config = JSON.parse(run(['config', '--type', 'public', '--json']));
for (const [key, expected] of [
  ['name', 'Captain'],
  ['slug', 'captain'],
]) {
  if (config[key] !== expected)
    throw new Error(`app config ${key}=${config[key]}, expected ${expected}`);
}
if (!config.sdkVersion?.startsWith('57.'))
  throw new Error(`unexpected sdkVersion ${config.sdkVersion}`);
console.log(`expo config ok (sdk ${config.sdkVersion})`);

const out = mkdtempSync(join(tmpdir(), 'captain-expo-export-'));
try {
  execFileSync(
    'pnpm',
    ['exec', 'expo', 'export', '--platform', 'android', '--platform', 'ios', '--output-dir', out],
    { stdio: 'inherit', env },
  );
  const bundles = readdirSync(join(out, '_expo', 'static', 'js'), { recursive: true }).filter(
    (f) => String(f).endsWith('.hbc') || String(f).endsWith('.js'),
  );
  if (bundles.length < 2)
    throw new Error(`expected android+ios bundles, found: ${bundles.join(', ')}`);
  console.log(`expo export ok: ${bundles.join(', ')}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
