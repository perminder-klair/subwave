// Pins for the typed env readers (src/util/env.ts).
//
// The behaviour that matters is the FALLBACK: config.ts used to read every
// numeric var through parseInt, which yields NaN for anything non-numeric and
// then lets the NaN travel (an uncapped headline fetch, a random listen port,
// `atempo=NaN` reaching ffmpeg). These readers turn that into a warning plus the
// documented default. They must never throw — a station that refuses to boot
// over one malformed convenience var is worse than one that boots on defaults.
//
// Run: `npm test -- env-config`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envEnum, envFloat, envInt, envIssues, envStr, envUrl } from '../src/util/env.js';

// Each case sets its own var name so the shared `envIssues` ledger stays
// readable and cases can't interfere with each other.
let n = 0;
function withEnv(value: string | undefined): string {
  const name = `SUBWAVE_TEST_VAR_${++n}`;
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return name;
}

test('a well-formed value is read, not defaulted', () => {
  assert.equal(envInt(withEnv('45'), 10), 45);
  assert.equal(envFloat(withEnv('1.25'), 1), 1.25);
  assert.equal(envUrl(withEnv('https://example.com/a.xml'), ''), 'https://example.com/a.xml');
  assert.equal(envStr(withEnv('hello'), 'fallback'), 'hello');
  assert.equal(envEnum(withEnv('cuda'), ['cpu', 'cuda'] as const, 'cpu'), 'cuda');
});

test('an absent var is the default, silently', () => {
  const before = envIssues().length;
  assert.equal(envInt(withEnv(undefined), 10), 10);
  assert.equal(envUrl(withEnv(undefined), 'http://d'), 'http://d');
  assert.equal(envIssues().length, before, 'not setting a var is not a mistake');
});

test('an EMPTY var means absent, not empty — `ANALYZE_URL=` is ordinary', () => {
  const before = envIssues().length;
  assert.equal(envUrl(withEnv(''), ''), '');
  assert.equal(envInt(withEnv('   '), 10), 10);
  assert.equal(envIssues().length, before);
});

test('surrounding whitespace is trimmed, not treated as junk', () => {
  const before = envIssues().length;
  assert.equal(envInt(withEnv(' 7701 '), 1), 7701);
  assert.equal(envIssues().length, before, 'a stray space from a copy-pasted .env is not an error');
});

test('the NaN case — junk falls back and is recorded', () => {
  const name = withEnv('ten');
  const before = envIssues().length;
  assert.equal(envInt(name, 10), 10);
  const issues = envIssues();
  assert.equal(issues.length, before + 1);
  assert.equal(issues[issues.length - 1].name, name);
  assert.equal(issues[issues.length - 1].value, 'ten');
  assert.equal(issues[issues.length - 1].usedInstead, '10');
});

test('a float is refused where an integer is meant, rather than truncated', () => {
  // parseInt('0.5') was 0 — an auto-playlist refresh cron that never rested.
  assert.equal(envInt(withEnv('0.5'), 60), 60);
});

test('bounds are enforced, and 0 is only allowed where it means something', () => {
  assert.equal(envInt(withEnv('0'), 7701), 7701, 'default min is 1');
  assert.equal(envInt(withEnv('0'), 250, { min: 0 }), 0, 'an explicit min: 0 accepts the disable value');
  assert.equal(envInt(withEnv('-5'), 250, { min: 0 }), 250);
  assert.equal(envInt(withEnv('70000'), 7701, { min: 1, max: 65_535 }), 7701);
});

test('a bare host is not a URL — the old `||` default accepted anything', () => {
  assert.equal(envUrl(withEnv('navidrome:4533'), 'http://navidrome:4533'), 'http://navidrome:4533');
  assert.equal(envUrl(withEnv('not a url'), 'http://d'), 'http://d');
  assert.equal(envUrl(withEnv('ftp://example.com'), 'http://d'), 'http://d', 'every URL here is fetched');
});

test('an unknown enum value falls back to the documented default', () => {
  assert.equal(envEnum(withEnv('gpu'), ['cpu', 'cuda'] as const, 'cpu'), 'cpu');
});

test('nothing throws, whatever the value', () => {
  for (const junk of ['', ' ', 'NaN', 'Infinity', '1e9', '0x10', '{}', '../../etc/passwd', '💾']) {
    assert.doesNotThrow(() => {
      envInt(withEnv(junk), 1);
      envFloat(withEnv(junk), 1);
      envUrl(withEnv(junk), 'http://d');
      envEnum(withEnv(junk), ['a', 'b'] as const, 'a');
    }, `threw on ${JSON.stringify(junk)}`);
  }
});

test('config.ts builds on real defaults with a hostile environment', async () => {
  process.env.NEWS_MAX_ITEMS = 'ten';
  process.env.PORT = 'eight thousand';
  process.env.PIPER_SPEED = 'fast';
  process.env.NAVIDROME_URL = 'navidrome:4533';
  process.env.ANALYZE_CONCURRENCY = 'many';
  const { config } = await import('../src/config.js');
  assert.equal(config.news.maxItems, 10);
  assert.equal(config.server.port, 7701);
  assert.equal(config.piper.speed, 1);
  assert.equal(config.navidrome.url, 'http://navidrome:4533');
  assert.equal(config.analyzer.concurrency, 1);
  assert.ok(Number.isFinite(config.tts.cloudSpeed), 'no NaN reaches the TTS layer');
});
