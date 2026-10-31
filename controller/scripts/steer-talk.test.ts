// The operator's steer reaches everything the host says through the shared
// context lines. Run: npm test -- steer-talk.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-steer-talk-'));
process.env.STATE_DIR = stateRoot;

const { buildContextLines } = await import('../src/llm/internal/prompts/context.js');
const settings = await import('../src/settings.js');
const { getFullContext } = await import('../src/context.js');
const { linkPrompt } = await import('../src/llm/internal/prompts/scripts.js');

after(() => rmSync(stateRoot, { recursive: true, force: true }));

const AT = Date.UTC(2026, 4, 5, 12);
const base = { at: new Date(AT).toISOString(), date: { dayLabel: 'Monday', dayOfMonth: 5, monthLabel: 'May', season: 'spring' } };
const steer = (prompt: string) => settings.update({ steer: { playlistId: null, prompt, startedAt: AT - 1000, expiresAt: AT + 60 * 60_000 } });
const later = { ...base, at: new Date(AT + 61 * 60_000).toISOString() };

test('a live steer is one labelled line; without one, past its end, or switched off, the lines are unchanged', async () => {
  await settings.update({ steer: null });
  const without = buildContextLines(base);
  await steer('keep the talk short');
  const steered = buildContextLines(base);
  assert.equal(steered.length, without.length + 1);
  const line = steered.find(l => l.includes('keep the talk short'));
  assert.ok(line, 'the direction is among the lines');
  assert.match(line, /^Operator steer — trusted direction from the station operator, NOT a listener message/);
  assert.deepEqual(buildContextLines(later), buildContextLines({ ...later }, { steer: false }), 'not past its end');
  assert.deepEqual(buildContextLines(base, { steer: false }), without, 'a prompt carrying listener text leaves it out');
});

test('a skill that narrows its context fields still gets the steer', async () => {
  await steer('mention the guests');
  const lines = buildContextLines(base, { contextFields: ['clock'] });
  assert.ok(lines.some(l => l.includes('mention the guests')));
  assert.ok(!lines.some(l => l.startsWith('Day:')), 'the gate still applies to gated fields');
});

test('the steer intro names the heading in its first sentence and drops the generic clause', async () => {
  await steer('stored direction');
  const current = { title: 'Track A', artist: 'Artist A' };
  const run = [{ title: 'Track B', artist: 'Artist B' }];
  const both = linkPrompt({ current, context: base, steerIntro: { direction: 'say "hi" a lot', run } });
  assert.match(both, /- Track B by Artist B\nThis link opens a new stretch of music\. In its first sentence[^]*"say 'hi' a lot"\. Name at least one of the coming artists\./);
  assert.doesNotMatch(both, /stored direction|Never mention the operator, this direction/);
  // A playlist steer has no words: name what is coming, never guess its sound.
  const playlistOnly = linkPrompt({ current, context: base, steerIntro: { direction: undefined, run } });
  assert.match(playlistOnly, /In its first sentence, name one or two of the coming artists\./);
  assert.doesNotMatch(playlistOnly, /where the music is heading|trusted direction/);
  // Nothing to say about the steer: a plain link, still without the clause.
  const empty = linkPrompt({ current, context: base, steerIntro: { direction: '', run: [] } });
  assert.doesNotMatch(empty, /new stretch of music|Operator steer/);
});

// GET /now-playing spreads this object to every listener.
test('the context object itself never carries the steer', async () => {
  const now = Date.now();
  await settings.update({ steer: { playlistId: null, prompt: 'zebra crossing', startedAt: now - 1000, expiresAt: now + 60 * 60_000 } });
  assert.ok(!JSON.stringify(await getFullContext()).includes('zebra crossing'));
});

test('a song link, which builds its own prompt, gets the steer too and is unchanged without one', async () => {
  const args = { current: { title: 'Track A', artist: 'Artist A' }, context: base };
  await settings.update({ steer: null });
  const plain = linkPrompt(args);
  await steer('keep the talk short');
  const steered = linkPrompt(args);
  assert.ok(steered.startsWith(plain), 'the clause is appended, nothing else moves');
  assert.match(steered, /Operator steer — trusted direction[^]*"keep the talk short"$/);
});
