// Patch @clack/prompts so its high-level wrappers forward an explicit
// `input` option through to @clack/core's prompt classes.
//
// Why — on macOS, Bun's `process.stdin` doesn't deliver bytes when the
// binary was launched from a parent process whose own stdin is piped
// (oven-sh/bun#13374). The workaround is to open /dev/tty ourselves as a
// fresh tty.ReadStream and hand THAT to the prompt as its `input`.
// @clack/core supports it (the `input?: Readable` option on PromptOptions),
// but @clack/prompts' shipped wrappers don't forward it — they only thread
// validate/placeholder/initialValue/etc. This script tweaks the dist file in
// place so the four wrappers we use (text/password/confirm/select) forward
// `input` too, after which cli/src/ui.ts can pass a /dev/tty stream into
// every prompt call.
//
// The mapping from friendly export name → minified class name is RESOLVED
// DYNAMICALLY rather than hardcoded, so a @clack/prompts patch-bump that
// reshuffles the minifier's letters doesn't silently inject `input` into the
// wrong wrapper (which would leave the real `text` prompt unpatched and the
// installer hanging). We read the export aliases (`<var> as text`), follow
// each to its wrapper definition (`<var>=<param>=>… new <Class>({`), and
// inject `input:<param>.input,` right after that class's `({`. Run
// idempotently — bails out if a class is already patched.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '..', 'node_modules', '@clack', 'prompts', 'dist', 'index.mjs');

const src = readFileSync(distPath, 'utf8');

// The four high-level wrappers whose prompts read keyboard input. (multiselect,
// groupMultiselect, autocomplete, etc. exist too but the CLI doesn't use them.)
const WRAPPERS = ['text', 'password', 'confirm', 'select'];

const ident = '[A-Za-z_$][\\w$]*';
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve { className, paramName } for a friendly export name by walking:
//   1. `<wrapperVar> as <friendly>`            (export alias)
//   2. `<wrapperVar>=<param>=>`  or  `=(…)=>`  (wrapper definition)
//   3. first `new <Class>({` after the definition (the prompt instantiation)
function resolveWrapper(friendly) {
  const alias = src.match(new RegExp(`(${ident}) as ${friendly}\\b`));
  if (!alias) {
    throw new Error(
      `patch-clack: no export alias "… as ${friendly}" in ${distPath}. ` +
      `Has @clack/prompts changed its exports? Inspect the dist and update WRAPPERS.`,
    );
  }
  const wrapperVar = alias[1];

  // `<var>=PARAM=>`  where PARAM is `ident` or `(…)`. Single options object in
  // practice, so the param is a plain identifier we can read `.input` off.
  const def = src.match(
    new RegExp(`\\b${escapeRe(wrapperVar)}=(?:\\((${ident})\\)|(${ident}))=>`),
  );
  if (!def) {
    throw new Error(
      `patch-clack: could not find wrapper definition for "${friendly}" (var ${wrapperVar}) in ${distPath}.`,
    );
  }
  const paramName = def[1] ?? def[2];
  const defIdx = def.index + def[0].length;

  // First class instantiation in the wrapper body is the prompt class.
  const after = src.slice(defIdx);
  const inst = after.match(new RegExp(`new (${ident})\\(\\{`));
  if (!inst) {
    throw new Error(
      `patch-clack: no "new <Class>({" after the "${friendly}" wrapper in ${distPath}.`,
    );
  }
  return { className: inst[1], paramName };
}

let out = src;
let patches = 0;
const skipped = [];
const seen = new Set();

for (const friendly of WRAPPERS) {
  const { className, paramName } = resolveWrapper(friendly);
  if (seen.has(className)) continue;
  seen.add(className);

  const needle = `new ${className}({`;
  const inject = `new ${className}({input:${paramName}.input,`;
  if (out.includes(`new ${className}({input:`)) {
    skipped.push(`${friendly}→${className}`);
    continue;
  }
  if (!out.includes(needle)) {
    throw new Error(`patch-clack: "${needle}" (for ${friendly}) vanished before injection in ${distPath}.`);
  }
  out = out.replace(needle, inject);
  patches++;
}

if (patches === 0) {
  console.log(`patch-clack: already applied (${skipped.join(', ') || 'no wrappers'}), no changes`);
} else {
  writeFileSync(distPath, out);
  console.log(`patch-clack: forwarded input through ${patches} wrappers (${WRAPPERS.join(', ')})`);
}
