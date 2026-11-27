// `npm run conformance -- <plugin-dir> …`: the conformance kit's command line in
// this repo. The kit itself is scripts/conformance.ts; the published package
// runs the same conformanceMain() (source-sdk/bin.ts).

import { conformanceMain } from './conformance.js';

process.exit(await conformanceMain(
  process.argv.slice(2),
  'npm run conformance -- <plugin-dir> [--config key=value ...] [--builtin] [--allow-writes] [--json]',
));
