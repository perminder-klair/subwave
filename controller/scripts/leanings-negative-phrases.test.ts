// Musical Leanings are positive-only (#1994). The review swaps only towards a
// phrase and credits the swap as a "taste for <phrase>", so a sentence written
// to steer AWAY from something must never come out of the extractor as a
// phrase: "Avoids stadium rock." used to become the phrase "Avoids stadium
// rock", and a positive sentence beside it hid the problem by winning the
// noun-phrase fallback. These pin the reading on both selection routes' one
// review pass (dj-agent/leanings-pass.ts) and on the extractor beneath it.

import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-leanings-negative-'));

const { agenticLeaningsSources } = await import('../src/broadcast/dj-agent/leanings-review.js');
const { runLeaningsReview } = await import('../src/broadcast/dj-agent/leanings-pass.js');
import type { PickResolution } from '../src/broadcast/dj-agent/leanings-review.js';

const phrases = (host: string) => agenticLeaningsSources({ host }).map(({ phrase }) => phrase);

test('the issue: an "Avoids" sentence is neither dropped into a fallback nor read beside a positive one', () => {
  assert.deepEqual(phrases('Favours northern soul and Motown. Avoids stadium rock.'), ['northern soul', 'Motown']);
  assert.deepEqual(phrases('Avoids stadium rock.'), [], 'a negative sentence alone yields no phrase, not the sentence itself');
});

test('a negative sentence yields nothing however it is phrased', () => {
  for (const text of [
    'No stadium rock.',
    'Never stadium rock.',
    'Steers clear of stadium rock.',
    'Stays away from stadium rock.',
    'Dislikes stadium rock.',
    "Can't stand stadium rock.",
    'Tends to avoid stadium rock.',
    'Stadium rock is to be avoided.',
    'Rarely enjoys stadium rock.',
    'Does not favour stadium rock.',
    "He doesn't love stadium rock.",
  ]) assert.deepEqual(phrases(text), [], text);
});

test('a negative clause inside a positive sentence ends its list, and governs every item after it', () => {
  assert.deepEqual(phrases('Favours northern soul but avoids stadium rock.'), ['northern soul']);
  assert.deepEqual(phrases('Favours northern soul and Motown, but avoids stadium rock.'), ['northern soul', 'Motown']);
  assert.deepEqual(phrases('Favours soul, never stadium rock and metal.'), ['soul'], '"metal" is ruled out too, not favoured');
  assert.deepEqual(phrases('Favours soul, definitely not stadium rock.'), ['soul']);
  assert.deepEqual(phrases('Favours soul — never metal.'), ['soul']);
  assert.deepEqual(phrases('Favours rock, except stadium rock and metal.'), ['rock']);
  assert.deepEqual(phrases('Northern soul, Motown, never stadium rock.'), ['Northern soul', 'Motown'], 'the noun-phrase fallback reads the same way');
});

test('a qualifier with nothing before it to qualify is an exclusion, not a phrase', () => {
  assert.deepEqual(phrases('Favours soul, with no metal.'), ['soul'], 'never the phrase "no metal"');
  assert.deepEqual(phrases('Favours soul, which never includes metal.'), ['soul']);
  assert.deepEqual(phrases('Northern soul, with no stadium rock.'), ['Northern soul'], 'the noun-phrase fallback reads the same way');
  assert.deepEqual(phrases('Favours instrumental music with no vocals.'), ['instrumental music with no vocals'], 'one that qualifies a preference still keeps it');
});

test('a positive clause after a negative one still counts', () => {
  assert.deepEqual(phrases('Avoids stadium rock but loves Motown.'), ['Motown']);
  assert.deepEqual(phrases("Can't stand stadium rock; loves deep house."), ['deep house']);
  assert.deepEqual(phrases('Steers clear of stadium rock. Prefers dub.'), ['dub']);
});

test('a negation that qualifies a preference keeps it, so positive Leanings read exactly as before', () => {
  assert.deepEqual(phrases('Favours records that are not overproduced.'), ['records that are not overproduced']);
  assert.deepEqual(phrases('Favours instrumental music with no vocals.'), ['instrumental music with no vocals']);
  assert.deepEqual(phrases('Favours dub while avoiding stadium rock.'), ['dub']);
  assert.deepEqual(phrases('Loves not only jazz but also soul.'), ['not only jazz but also soul']);
  assert.deepEqual(phrases('Loves anything but metal.'), ['anything but metal'], 'never "metal" on its own');
  assert.deepEqual(phrases('Favours post-punk, no wave and krautrock.'), ['post-punk', 'no wave', 'krautrock'], 'no wave is a genre');
  assert.deepEqual(phrases('Favours no-frills garage rock.'), ['no-frills garage rock']);
  assert.deepEqual(phrases('Favour patient dub, deep electronic cuts, and melodic post-punk.'), ['patient dub', 'deep electronic cuts', 'melodic post-punk']);
  assert.deepEqual(phrases('patient dub'), ['patient dub']);
});

test('a guest source is read by the same rule', () => {
  const sources = agenticLeaningsSources({
    host: 'Favours dub.',
    guest: { guest: { name: 'Carrie Marshall' }, musicalLeanings: 'Avoids synth-pop.' },
  }, 'Mara Vex');
  assert.deepEqual(sources, [{ phrase: 'dub', source: 'host', ownerName: 'Mara Vex' }]);
});

const baseline = { id: 'baseline', title: 'Base Line', artist: 'First Artist', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 120, key: '8A', instrumental: false };
const synth = { id: 'synth', title: 'Glass Pulse', artist: 'Second Artist', energy: 'medium', moods: ['reflective'], genre: 'Synth-Pop', bpm: 121, key: '8A', instrumental: false };
const plain = { id: 'plain', title: 'Plain Song', artist: 'Third Artist', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 122, key: '8A', instrumental: false };
const seen = new Map([baseline, synth, plain].map((track) => [track.id, track]));

async function review(host: string, answer: unknown) {
  const prompts: string[] = [];
  const logLines: string[] = [];
  const resolution: PickResolution = {};
  const result = await runLeaningsReview({
    song: baseline,
    object: { id: baseline.id, reason: 'baseline reason', transition: 'normal' },
    seen,
    editorialLeanings: { host, guest: null, promptValue: `Host: ${host}` },
    djName: 'Mara Vex',
    context: {},
    resolution,
    route: {
      kind: 'djAgentLeaningsReview',
      telemetry: {},
      label: 'Agentic Leanings review',
      fallback: 'using the baseline',
      failureEvent: 'pick.leaningsReviewFailed',
      replacementReason: (replacement, leaningsReason) => `${replacement.id}: ${leaningsReason}`,
    },
    reviewTimeoutMs: 45_000,
    review: async (request) => { prompts.push(request.prompt); return answer; },
    log: (line) => logLines.push(line),
    logEvent: () => {},
  });
  return { result, resolution, prompts, logLines };
}

test('a Leanings field that only says what to avoid spends no review call and keeps the baseline', async () => {
  const { result, resolution, prompts } = await review('Avoids synth-pop.', {
    selectedId: 'synth', leaningsBasis: 'Avoids synth-pop', musicalReason: 'its glassy synth pulse brightens the sequence', transition: null,
  });
  assert.equal(prompts.length, 0, 'there is no positive preference to review against');
  assert.equal(result.song.id, 'baseline');
  assert.equal(result.reviewed, false);
  assert.equal(resolution.leaningsReview?.outcome, 'not-run');
});

test('the avoided subject never reaches the review as an option, and a swap claiming it is refused', async () => {
  const { result, resolution, prompts, logLines } = await review('Favour warm voices, but avoid synth-pop.', {
    selectedId: 'synth', leaningsBasis: 'synth-pop', musicalReason: 'its glassy synth pulse brightens the sequence', transition: null,
  });
  assert.equal(prompts.length, 1);
  const payload = JSON.parse(prompts[0].slice(0, prompts[0].indexOf('\n\nleaningsSources identifies')));
  assert.deepEqual(payload.leaningsOptions, ['warm voices']);
  assert.deepEqual(payload.context.interpretableLeaningsOptions, ['warm voices']);
  assert.equal(result.song.id, 'baseline', 'no "taste for synth-pop" swap');
  assert.equal(resolution.leaningsReview?.outcome, 'invalid');
  assert.equal(resolution.leaningsReview?.rejectionReason, 'missing-leanings-basis');
  assert.ok(logLines.some((line) => /missing-leanings-basis/.test(line)));
});
