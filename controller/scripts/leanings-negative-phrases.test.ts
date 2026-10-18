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
    'Excludes metal.',
    'Refuses to play metal.',
  ]) assert.deepEqual(phrases(text), [], text);
});

test('a negative clause inside a positive sentence ends its list, and governs every item after it', () => {
  assert.deepEqual(phrases('Favours northern soul but avoids stadium rock.'), ['northern soul']);
  assert.deepEqual(phrases('Favours northern soul and Motown, but avoids stadium rock.'), ['northern soul', 'Motown']);
  assert.deepEqual(phrases('Favours soul, never stadium rock and metal.'), ['soul'], '"metal" is ruled out too, not favoured');
  assert.deepEqual(phrases('Favours soul, definitely not stadium rock.'), ['soul']);
  assert.deepEqual(phrases('Favours soul — never metal.'), ['soul']);
  assert.deepEqual(phrases('Favours rock, except stadium rock and metal.'), ['rock']);
  assert.deepEqual(phrases('Favours rock but excludes metal.'), ['rock']);
  assert.deepEqual(phrases('Favours soul, refusing metal.'), ['soul']);
  assert.deepEqual(phrases('Northern soul, Motown, never stadium rock.'), ['Northern soul', 'Motown'], 'the noun-phrase fallback reads the same way');
});

test('a universal item goes with the exclusion that limited it', () => {
  for (const text of [
    'Loves anything except metal.',
    'Favours everything apart from stadium rock.',
    'Favours all genres except metal.',
    'Favours any genre except metal.',
    'Open to anything except stadium rock.',
    'Loves anything, but never metal.',
  ]) assert.deepEqual(phrases(text), [], `${text} must not leave a taste for "anything" that covers what it excluded`);
  assert.deepEqual(phrases('Favours soul and anything except metal.'), ['soul']);
  assert.deepEqual(phrases('Favours any jazz except bebop.'), ['any jazz'], 'a real taste survives');
  assert.deepEqual(phrases('Loves soul more than anything, never metal.'), ['soul more than anything']);
  assert.deepEqual(phrases('Favours Motown, except the disco years.'), ['Motown']);
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
  assert.deepEqual(phrases("Doesn't favour stadium rock but loves Motown."), ['Motown'], 'a negated trigger does not hide a later one');
  assert.deepEqual(phrases('Does not favour or enjoy stadium rock.'), [], 'a later trigger inside the same negation stays negated');
});

test('a comma or "and" before a trigger opens a new clause, unless the negation before it is left hanging', () => {
  assert.deepEqual(phrases('Hates stadium rock, loves Motown.'), ['Motown']);
  assert.deepEqual(phrases('Avoids stadium rock and loves Motown.'), ['Motown']);
  assert.deepEqual(phrases('Hates stadium rock, loves Motown and northern soul.'), ['Motown', 'northern soul']);
  assert.deepEqual(phrases('Not into stadium rock, and loves Motown.'), ['Motown']);
  for (const text of [
    'Never, ever enjoys metal.',
    'He never, ever loves metal.',
    'Does not favour, and does not enjoy, metal.',
    'Does not, and will never, enjoy metal.',
    "Doesn't, and never will, enjoy metal.",
    "Doesn't, frankly, enjoy metal.",
    'Never once, in thirty years, enjoys metal.',
    'Avoids metal and enjoys no prog.',
  ]) assert.deepEqual(phrases(text), [], text);
});

test('a negation that qualifies a preference keeps it', () => {
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

test('an idiom of fondness, or a cue word describing the records, is not a negation', () => {
  assert.deepEqual(phrases('Favours British jazz, not least Shabaka Hutchings and Nubya Garcia.'), ['British jazz', 'not least Shabaka Hutchings', 'Nubya Garcia']);
  assert.deepEqual(phrases('Loves soul, not to mention funk and disco.'), ['soul', 'not to mention funk', 'disco']);
  assert.deepEqual(phrases('Favours soul no matter the hour.'), ['soul no matter the hour']);
  assert.deepEqual(phrases("Can't get enough of dub and krautrock."), ["Can't get enough of dub", 'krautrock']);
  assert.deepEqual(phrases('Never tires of northern soul and Motown.'), ['Never tires of northern soul', 'Motown']);
  assert.deepEqual(phrases('Favours instrumental tracks with little to no vocals.'), ['instrumental tracks with little to no vocals']);
  assert.deepEqual(phrases('Favours ambient with hardly any percussion and long drones.'), ['ambient with hardly any percussion', 'long drones']);
  assert.deepEqual(phrases('Loves rarely played soul 45s and northern soul.'), ['rarely played soul 45s', 'northern soul']);
  assert.deepEqual(phrases('Favours obscure B-sides and seldom heard library music.'), ['obscure B-sides', 'seldom heard library music']);
  assert.deepEqual(phrases('Loves the rarely heard deep cuts.'), ['rarely heard deep cuts']);
  assert.deepEqual(phrases('Loves those seldom played 45s and dub.'), ['those seldom played 45s', 'dub']);
  assert.deepEqual(phrases('Favours soul. Metal rarely played.'), ['soul'], 'a participle that closes the clause still steers away');
  assert.deepEqual(phrases('Favours soul, rarely played on air metal.'), ['soul']);
  assert.deepEqual(phrases('Favours soul, rarely metal.'), ['soul']);
});

test('a non-English name is not read as holding a negation', () => {
  assert.deepEqual(phrases('Favours French jazz: Noël Akchoté and Django Reinhardt.'), ['French jazz: Noël Akchoté', 'Django Reinhardt']);
  assert.deepEqual(phrases('Favours Japanese jazz, Yūji Ōno and Ryo Fukui.'), ['Japanese jazz', 'Yūji Ōno', 'Ryo Fukui']);
  assert.deepEqual(phrases('Favours Noémie Ouellette and Québécois folk.'), ['Noémie Ouellette', 'Québécois folk']);
  assert.deepEqual(phrases('Favours anime soundtracks like Shingeki no Kyojin and Yoko Kanno.'), ['anime soundtracks like Shingeki no Kyojin', 'Yoko Kanno']);
  assert.deepEqual(phrases('Favours city pop such as Mayonaka no Door and Mariya Takeuchi.'), ['city pop such as Mayonaka no Door', 'Mariya Takeuchi']);
  assert.deepEqual(phrases('Favours soul, no Motown.'), ['soul'], 'a lowercase "no" before a name still rules it out');
});

test('a capitalised name given as an example is an act, not a negation', () => {
  assert.deepEqual(phrases('Favours ska punk like No Doubt and Rancid.'), ['ska punk like No Doubt', 'Rancid']);
  assert.deepEqual(phrases('Favours bluegrass like The Seldom Scene and Alison Krauss.'), ['bluegrass like The Seldom Scene', 'Alison Krauss']);
  assert.deepEqual(phrases('Favours noise rock such as No Age and Lightning Bolt.'), ['noise rock such as No Age', 'Lightning Bolt']);
  assert.deepEqual(phrases('Favours ska punk, e.g. No Doubt and Rancid.'), ['ska punk', 'e.g. No Doubt', 'Rancid'], 'the dots of "e.g." do not end the sentence');
  assert.deepEqual(phrases('Favours hardcore: Refused, Converge and Botch.'), ['hardcore: Refused', 'Converge', 'Botch'], '"refused" is not a cue: it is a band');
  assert.deepEqual(phrases('Favours soul, never stadium rock and metal.'), ['soul'], 'a lowercase cue is never read as a name');
  assert.deepEqual(phrases('Favours Soul: No Stadium Rock and Metal.'), [], 'a colon introduces no example');
  assert.deepEqual(phrases('Favours Soul, Never Stadium Rock, Metal or Prog.'), ['Soul'], 'outside an example a capitalised cue still ends its list');
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

// The answer is one the old reader accepted: it offered "but avoid synth-pop"
// as an option, and this grounded comparison swapped to Glass Pulse for "Mara
// Vex's taste for but avoid synth-pop".
test('the avoided clause never reaches the review as an option, and a swap claiming it is refused', async () => {
  const { result, resolution, prompts, logLines } = await review('Favour warm voices, but avoid synth-pop.', {
    selectedId: 'synth', leaningsBasis: 'but avoid synth-pop', musicalReason: 'its glassy synth pulse brightens the sequence', transition: null,
    editorialEvidence: {
      baselineFacts: [{ field: 'genre', value: 'Electronic' }],
      challengerFacts: [{ field: 'genre', value: 'Synth-Pop' }],
      comparison: 'Moving from Electronic to Synth-Pop answers "but avoid synth-pop" head on.',
    },
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
