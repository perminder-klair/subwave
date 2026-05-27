// Patch @clack/prompts so its high-level wrappers forward an explicit
// `input` option through to @clack/core's prompt classes.
//
// Why — on macOS, Bun's `process.stdin` doesn't deliver bytes when the
// binary was launched from a parent process whose own stdin is piped
// (oven-sh/bun#13374). The `curl … | sh → exec subwave init </dev/tty`
// flow hits this exactly: even though fd 0 is /dev/tty, Bun's stdin
// layer never produces data, so `p.text({…})` renders the prompt and
// then hangs.
//
// The workaround is to open /dev/tty ourselves as a fresh tty.ReadStream
// and hand THAT to the prompt as its `input`. @clack/core supports it
// (the `input?: Readable` option on PromptOptions). @clack/prompts'
// shipped wrappers don't forward `s.input` though — they only thread
// validate/placeholder/initialValue/etc. This script tweaks the dist
// file in place so the wrappers forward `input` too, after which our
// ui.ts can pass a /dev/tty stream into every prompt call.
//
// The patch is a single line — insert `input:s.input,` immediately
// after the opening `new <ClassName>({` in each of the four wrappers
// we use (TextPrompt, PasswordPrompt, ConfirmPrompt, SelectPrompt).
// Run idempotently — bails out if the patch is already applied.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '..', 'node_modules', '@clack', 'prompts', 'dist', 'index.mjs');

const src = readFileSync(distPath, 'utf8');

// Minifier mangles class names; the @clack/prompts dist (v0.8.x) names
// them W (TextPrompt), q (PasswordPrompt), F (ConfirmPrompt),
// N (SelectPrompt) at the top of the file. If you bump the dep, eyeball
// these names again — `grep -oE "new [A-Z]\(\{" dist/index.mjs`.
const CLASS_NAMES = ['W', 'q', 'F', 'N'];

let out = src;
let patches = 0;
for (const name of CLASS_NAMES) {
  // Match the literal `new <name>({` opening. The `input:s.input,`
  // injection lands before the next existing option. `s` is the wrapper
  // function's single argument across all four; if a future version of
  // clack renames it, update here.
  const needle = `new ${name}({`;
  const inject = `new ${name}({input:s.input,`;
  if (out.includes(inject)) {
    // Already patched — skip.
    continue;
  }
  if (!out.includes(needle)) {
    throw new Error(
      `patch-clack: could not find "${needle}" in ${distPath}. ` +
      `Has @clack/prompts been re-minified? Re-run \`grep -oE "new [A-Z]\\(\\{" ${distPath}\` ` +
      `and update CLASS_NAMES.`,
    );
  }
  out = out.replace(needle, inject);
  patches++;
}

if (patches === 0) {
  console.log('patch-clack: already applied, no changes');
} else {
  writeFileSync(distPath, out);
  console.log(`patch-clack: forwarded input through ${patches} wrappers`);
}
