// `npx @subwave/source-sdk conformance <plugin-dir> …`: the conformance kit for
// plugin authors outside the SUB/WAVE repo. It is router/scripts/conformance.ts,
// the same checks through the same enforcement layer the router uses, bundled
// by build-bin.mjs into one dependency-free file (dist/cli.js).

import { conformanceMain } from '../scripts/conformance.js';

const USAGE = `@subwave/source-sdk — tools for SUB/WAVE music-source plugins

Usage:
  npx @subwave/source-sdk conformance <plugin-dir> [--config key=value ...] [--allow-writes] [--json]

  Runs the conformance kit against a plugin folder (its subwave-source.json and
  entry module): the checks a station relies on, through the router's own
  enforcement layer. Reads only, unless --allow-writes, which also stars and
  unstars a track and creates, edits and deletes a scratch playlist.

  Exit code 0 = every check passed (warnings allowed), 1 = a check failed.
`;

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'conformance') {
  process.exit(await conformanceMain(
    rest,
    'npx @subwave/source-sdk conformance <plugin-dir> [--config key=value ...] [--allow-writes] [--json]',
  ));
} else {
  (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h' ? process.stdout : process.stderr).write(USAGE);
  process.exit(cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 2);
}
