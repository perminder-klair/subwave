// Patch @clack/prompts' dist so its text/password/confirm/select wrappers
// forward an explicit `input` option to @clack/core's prompt classes. On macOS
// Bun's process.stdin delivers no bytes when the parent's stdin is piped
// (oven-sh/bun#13374), so cli/src/ui.ts hands prompts a /dev/tty stream instead.
//
// Friendly export name → minified class name is resolved dynamically, not
// hardcoded, so a patch-bump that reshuffles the minifier's letters can't inject
// `input` into the wrong wrapper. Idempotent: bails if a class is already patched.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '..', 'node_modules', '@clack', 'prompts', 'dist', 'index.mjs');

const src = readFileSync(distPath, 'utf8');

// The high-level wrappers the CLI uses that read keyboard input.
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

  // `<var>=PARAM=>` where PARAM is `ident` or `(…)`; in practice a single
  // options object, so `.input` can be read off it.
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
