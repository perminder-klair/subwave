// @subwave/source-sdk (router/source-sdk) is built from src/sdk, the same
// files the router type-checks against. These pin what the published package
// promises: its major is the plugin apiVersion, it builds to a self-contained
// module with no dependencies, and plain-JS plugins can type against it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCE_API_VERSION } from '../src/sdk/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(here, '../source-sdk');
const TSC = resolve(here, '../node_modules/typescript/bin/tsc');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));

test('the package major is the plugin apiVersion the router implements', () => {
  assert.equal(pkg.name, '@subwave/source-sdk');
  assert.equal(Number(String(pkg.version).split('.')[0]), SOURCE_API_VERSION);
});

test('the package carries no dependencies, so it is safe as a dev dependency of any plugin', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.deepEqual(pkg.files, ['dist']);
});

test('it builds from src/sdk to a module that imports only its own files', async () => {
  const out = mkdtempSync(join(tmpdir(), 'source-sdk-build-'));
  try {
    execFileSync(process.execPath, [TSC, '-p', join(PKG_DIR, 'tsconfig.json'), '--outDir', out], { stdio: 'pipe' });
    assert.deepEqual(readdirSync(out).sort(), ['index.d.ts', 'index.js', 'types.d.ts', 'types.js']);

    for (const f of ['index.js', 'types.js', 'index.d.ts', 'types.d.ts']) {
      // Statements only: the header comment shows an import of the package itself.
      const specifiers = [...readFileSync(join(out, f), 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)]
        .map((m) => m[1]);
      assert.ok(f.startsWith('index') ? specifiers.length > 0 : true, `${f}: no imports found, the pattern is stale`);
      for (const s of specifiers) assert.ok(s.startsWith('./'), `${f} imports ${s}`);
    }

    const sdk = await import(pathToFileURL(join(out, 'index.js')).href);
    const factory = () => ({});
    assert.equal(sdk.defineSource(factory), factory);
    assert.equal(sdk.SOURCE_API_VERSION, SOURCE_API_VERSION);
    assert.equal(sdk.isVariousArtists(' Various Artists '), true);

    // A plain-JS plugin typed with JSDoc against the built declarations, the
    // way the folder example and the package README use it.
    const plugin = join(out, 'plugin.mjs');
    const body = (song: string) =>
      `/** @type {import('./index.js').SourceFactory} */\n` +
      `export default (ctx) => ({\n` +
      `  async song(id) { ctx.log.info(id); return ${song}; },\n` +
      `  async album() { return undefined; },\n` +
      `  async artist() { return undefined; },\n` +
      `  async genres() { return []; },\n` +
      `  async albumList() { return []; },\n` +
      `  async songsByGenre() { return []; },\n` +
      `  async randomSongs() { return []; },\n` +
      `  async search() { return { artists: [], albums: [], songs: [] }; },\n` +
      `  async stream() { return undefined; },\n` +
      `  async coverArt() { return undefined; },\n` +
      `});\n`;
    writeFileSync(plugin, body(`{ id, title: 't' }`));
    const checkConfig = join(out, 'tsconfig.check.json');
    writeFileSync(checkConfig, JSON.stringify({
      compilerOptions: {
        noEmit: true, allowJs: true, checkJs: true, strict: true, types: [],
        module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', lib: ['ES2022', 'DOM'],
      },
      files: [plugin],
    }));
    execFileSync(process.execPath, [TSC, '-p', checkConfig], { stdio: 'pipe' });

    // …and a wrong one is caught, so the check above is not vacuous.
    writeFileSync(plugin, body(`{ id: 1 }`));
    assert.throws(() => execFileSync(process.execPath, [TSC, '-p', checkConfig], { stdio: 'pipe' }));

    // The documented example types itself against the package, so a contract
    // change that breaks it fails here rather than in an author's editor.
    const exampleConfig = join(out, 'tsconfig.example.json');
    writeFileSync(exampleConfig, JSON.stringify({
      compilerOptions: {
        noEmit: true, allowJs: true, checkJs: true, strict: false, module: 'NodeNext', moduleResolution: 'NodeNext',
        target: 'ES2022', lib: ['ES2022', 'DOM'], types: ['node'], typeRoots: [resolve(here, '../node_modules/@types')],
        paths: { '@subwave/source-sdk': [join(out, 'index.d.ts')] },
      },
      files: [resolve(here, '../../docs/examples/sources/folder/index.mjs')],
    }));
    execFileSync(process.execPath, [TSC, '-p', exampleConfig], { stdio: 'pipe' });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    if (e.stdout || e.stderr) assert.fail(`${e.stdout ?? ''}${e.stderr ?? ''}`);
    throw err;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  assert.equal(existsSync(out), false);
});
