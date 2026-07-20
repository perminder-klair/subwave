// Unit tests for the theme token registry — the single source of truth the
// controller validator and the generated web mirror both read. Run:
// `npm test -- theme-tokens` (auto-discovered by run-tests.ts).
//
// Pins the invariants that keep the registry safe and the mirror honest: every
// token has a known type, colour values reject CSS-breakout payloads, the font
// token only accepts curated ids, grain stays in [0,1], and the swatch keys are
// a subset of the token keys.

import assert from 'node:assert/strict';
import {
  THEME_TOKENS,
  THEME_TOKEN_KEYS,
  SWATCH_KEYS,
  DISPLAY_FONT_IDS,
  tokenType,
  isValidTokenValue,
} from '../src/theme-tokens.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

test('every descriptor has a valid type + non-empty label/key', () => {
  for (const t of THEME_TOKENS) {
    assert.ok(t.key.startsWith('--'), `key ${t.key} must start with --`);
    assert.ok(t.label.length > 0, `${t.key} needs a label`);
    assert.ok(['color', 'font', 'grain'].includes(t.type), `${t.key} bad type`);
  }
});

test('THEME_TOKEN_KEYS mirrors descriptor keys, no dupes', () => {
  assert.deepEqual(THEME_TOKEN_KEYS, THEME_TOKENS.map((t) => t.key));
  assert.equal(new Set(THEME_TOKEN_KEYS).size, THEME_TOKEN_KEYS.length);
});

test('the seven legacy tokens still exist (back-compat)', () => {
  for (const k of ['--bg', '--ink', '--muted', '--accent', '--overlay', '--soft-border', '--field']) {
    assert.ok(THEME_TOKEN_KEYS.includes(k), `missing legacy token ${k}`);
  }
});

test('swatch keys are a subset of token keys', () => {
  for (const k of SWATCH_KEYS) assert.ok(THEME_TOKEN_KEYS.includes(k), `swatch ${k} not a token`);
});

test('tokenType resolves known keys and rejects unknown', () => {
  assert.equal(tokenType('--bg'), 'color');
  assert.equal(tokenType('--display-font'), 'font');
  assert.equal(tokenType('--grain'), 'grain');
  assert.equal(tokenType('--nope'), undefined);
});

test('colour tokens accept real values, reject breakout payloads', () => {
  assert.ok(isValidTokenValue('--bg', '#ff4d00'));
  assert.ok(isValidTokenValue('--surface', 'color-mix(in oklab, #fff 90%, #000)'));
  assert.ok(isValidTokenValue('--accent', 'oklch(0.62 0.22 25)'));
  assert.ok(!isValidTokenValue('--bg', 'red; background:url(x)'), 'semicolon must be rejected');
  assert.ok(!isValidTokenValue('--bg', '<script>'), 'angle brackets rejected');
  assert.ok(!isValidTokenValue('--bg', '}'), 'brace rejected');
  assert.ok(!isValidTokenValue('--bg', ''), 'empty rejected');
  assert.ok(!isValidTokenValue('--bg', 'x'.repeat(101)), 'over-long rejected');
});

test('font token accepts only curated ids', () => {
  for (const id of DISPLAY_FONT_IDS) assert.ok(isValidTokenValue('--display-font', id), `id ${id}`);
  assert.ok(!isValidTokenValue('--display-font', 'comic-sans'), 'unknown font id rejected');
  assert.ok(!isValidTokenValue('--display-font', 'var(--x), serif'), 'raw font string rejected');
});

test('grain token accepts [0,1] numbers only', () => {
  for (const v of ['0', '0.5', '1']) assert.ok(isValidTokenValue('--grain', v), `grain ${v}`);
  for (const v of ['-0.1', '1.1', 'abc', '']) assert.ok(!isValidTokenValue('--grain', v), `grain ${v} rejected`);
});

test('unknown keys never validate', () => {
  assert.ok(!isValidTokenValue('--danger', 'anything'));
});

if (failures > 0) {
  console.error(`\n${failures} theme-token test(s) failed`);
  process.exit(1);
}
console.log('\nall theme-token tests passed');
