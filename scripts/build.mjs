// Node code is compiled by tsc; the script injected into the meeting page is
// one self-contained bundle (it carries livekit-client with it).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });

await build({
  entryPoints: ['src/inject/index.ts'],
  outfile: 'dist/inject.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  legalComments: 'none',
  // Names the bundle in stack traces: patch.ts tells its own peer connections by it.
  footer: { js: '//# sourceURL=atmanity-google-meet-bridge-inject.js' },
});
