// Bundles bin.ts (the conformance kit and the router modules it runs through,
// zod included) into dist/cli.js: one file, nothing to install beside it, so
// the published package keeps no dependencies. Not minified, so an author can
// read what they run. esbuild comes from router/node_modules (`npm --prefix
// router ci` first). Usage: node build-bin.mjs [outfile]

import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(process.argv[2] ?? join(here, 'dist', 'cli.js'));

await build({
  entryPoints: [join(here, 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  legalComments: 'inline',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
