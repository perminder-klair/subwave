// Check that a compiled `subwave` binary carries the patch-clack.mjs fix: the
// @clack/prompts text/password/confirm/select wrappers must forward the
// /dev/tty stream as `input`, or prompts launched from a piped parent hang on
// macOS (oven-sh/bun#13374). Release builds once skipped the patch because CI
// calls `bun build` directly rather than `npm run build:*` (#2202), so this
// inspects what actually ships rather than trusting the build steps.
//
// Bun embeds the bundled JS as text in the executable (ELF and Mach-O alike),
// and may reprint it with spaces, so the match is whitespace-tolerant.
//
// Usage: node scripts/check-clack-patch.mjs <path-to-compiled-subwave>
// Exit codes: 0 patched, 1 patch missing, 2 bad usage / unreadable file.

import { readFileSync } from 'node:fs';

// EXPECTED must match WRAPPERS in patch-clack.mjs (one forwarded site per
// wrapper). `>=` so an upstream that forwards input itself doesn't fail.
const EXPECTED = 4;

const USAGE = 'usage: node scripts/check-clack-patch.mjs <path-to-compiled-subwave>';

const binary = process.argv[2];
if (!binary) {
  console.error(USAGE);
  process.exit(2);
}

let text;
try {
  text = readFileSync(binary, 'latin1');
} catch (err) {
  console.error(`check-clack-patch: cannot read ${binary}: ${err.message}`);
  console.error(USAGE);
  process.exit(2);
}

// `new <Class>({ input: <param>.input,` — the shape patch-clack.mjs injects.
const site = /new\s+[A-Za-z_$][\w$]*\(\{\s*input:\s*[A-Za-z_$][\w$]*\.input\s*,/g;
const count = (text.match(site) ?? []).length;

if (count < EXPECTED) {
  console.error(
    `check-clack-patch: ${binary} forwards input at ${count} of ${EXPECTED} Clack prompt sites; ` +
    `patch-clack.mjs did not reach this build (#2202). ` +
    'Run `npm run patch-clack` (or `bun run patch-clack`) after install and before `bun build`.',
  );
  process.exit(1);
}

console.log(`check-clack-patch: ${binary} forwards input at ${count} prompt sites`);
