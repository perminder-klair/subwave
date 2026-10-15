import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-leanings-regressions-'));
const settings = await import('../src/settings.js');
await settings.load();
const session = await import('../src/broadcast/session.js');
const context = await import('../src/context.js');
const { config } = await import('../src/config.js');
const { agenticLeaningsPhrases, agenticLeaningsSources, eligibleAgenticLeanings, compactAgenticReviewCandidate,
  agenticLeaningsSelectionReason, leaningsBlindPickReason, validateAgenticLeaningsReplacement,
} = await import('../src/broadcast/dj-agent/leanings-review.js');
const { agenticLeaningsReviewPrompt } = await import('../src/broadcast/dj-agent/schemas.js');

const baseline = { id: 'baseline', title: 'Original', artist: 'Original Artist', genre: 'ambient', energy: 'medium', moods: ['reflective'], bpm: 120, key: '8A' };
const hostTrack = { ...baseline, id: 'host-track', genre: 'dub' };
const guestTrack = { ...baseline, id: 'guest-track', title: 'Guest Choice', artist: 'Guest Artist', genre: 'classical' };
const preferences = { host: 'patient dub', guest: { guest: { name: 'Guest DJ' }, musicalLeanings: 'She favours classical.' } };

test('short genres work as bare preferences and in sentences, regardless of case', () => {
  for (const genre of ['jazz', 'Jazz', 'JAZZ', 'rock', 'soul', 'folk', 'pop', 'ska', 'dub', 'IDM']) {
    for (const host of [genre, `I love ${genre}.`]) {
      const phrases = agenticLeaningsPhrases({ host, guest: null });
      assert.deepEqual(phrases, [genre]);
      assert.deepEqual(compactAgenticReviewCandidate({ ...baseline, genre }, phrases, baseline).leaningsMatches, [genre]);
    }
  }
  assert.deepEqual(agenticLeaningsPhrases({ host: 'music, tracks, sounds', guest: null }), []);
});

test('each persona gets its own noun-phrase fallback and duplicates belong to the host', () => {
  assert.deepEqual(agenticLeaningsPhrases(preferences), ['patient dub', 'classical']);
  assert.deepEqual(agenticLeaningsSources(preferences, 'Host DJ'), [
    { phrase: 'patient dub', source: 'host', ownerName: 'Host DJ' },
    { phrase: 'classical', source: 'guest', ownerName: 'Guest DJ' },
  ]);
  assert.deepEqual(agenticLeaningsSources({ host: 'jazz', guest: { musicalLeanings: 'She loves Jazz and soul.' } }).map(({ phrase, source }) => ({ phrase, source })), [
    { phrase: 'jazz', source: 'host' }, { phrase: 'soul', source: 'guest' },
  ]);
});

test('viable host evidence prevents a conflicting guest replacement, including a host-supported baseline', () => {
  const sources = agenticLeaningsSources({ ...preferences, host: 'dub' }, 'Host DJ');
  for (const original of [baseline, hostTrack]) {
    const eligible = eligibleAgenticLeanings(original, [hostTrack, guestTrack], sources);
    assert.deepEqual(eligible.map(({ phrase }) => phrase), ['dub']);
    const candidate = compactAgenticReviewCandidate(guestTrack, eligible.map(({ phrase }) => phrase), original);
    assert.equal(validateAgenticLeaningsReplacement({ musicalReason: 'its strings add a delicate texture to the sequence',
      leaningsBasis: 'classical', musicalLeanings: 'Host: dub; Guest: classical', allowedLeanings: eligible.map(({ phrase }) => phrase),
      supportedLeanings: [], baselineSupportedLeanings: [], flowCloseness: candidate.flowCloseness,
    }).valid, false);
  }
  const prompt = agenticLeaningsReviewPrompt({ baseline, challengers: [hostTrack, guestTrack], leaningsOptions: ['dub'], leaningsSources: sources });
  assert.match(prompt, /Host preferences are primary/);
  assert.match(prompt, /"source": "guest"/);
  assert.match(prompt, /Guest DJ/);
});

test('guest-only preferences remain eligible and the displayed reason credits the guest', () => {
  const sources = agenticLeaningsSources({ ...preferences, host: null }, 'Host DJ');
  assert.deepEqual(eligibleAgenticLeanings(baseline, [guestTrack], sources), sources);
  const mixed = agenticLeaningsSources({ ...preferences, host: 'dub' }, 'Host DJ');
  const weakHost = { ...hostTrack, energy: 'high', moods: ['workout'], bpm: 75, key: '2B' };
  assert.deepEqual(eligibleAgenticLeanings(baseline, [weakHost, guestTrack], mixed), mixed, 'weak flow cannot suppress a viable guest nudge');
  const reason = agenticLeaningsSelectionReason({ replacement: guestTrack, djName: 'Host DJ', leaningsOwnerName: sources[0].ownerName,
    basis: 'classical', musicalReason: 'its strings add a delicate texture to the sequence' });
  assert.match(reason, /Host DJ chose/);
  assert.match(reason, /Guest DJ’s taste for classical/);
  assert.doesNotMatch(reason, /Host DJ’s taste/);
  assert.doesNotMatch(leaningsBlindPickReason(reason, guestTrack), /classical|Guest DJ/);
});

test('preference claims are removed for every permitted presenter name', () => {
  for (const djName of ['DJ 2.0', 'RADIO.X', '97.3', 'X', 'Charles', 'Zoë']) {
    const reason = agenticLeaningsSelectionReason({ replacement: guestTrack, djName, basis: 'dub', musicalReason: 'its strings add a delicate texture to the sequence' });
    assert.doesNotMatch(leaningsBlindPickReason(reason, guestTrack), /dub|taste|reflecting/i, djName);
  }
});

test('selection and request windows exclude preference reasons after clearing settings and recovering old state', async () => {
  const at = new Date();
  const ctx = { at: at.toISOString(), time: context.getTimeContext(at), weather: null, festival: null, dominantMood: 'calm',
    date: context.getDateContext(at), clock: context.getClockContext(at), activeShow: null, showHandover: null,
    listeners: { count: 1 }, episodeEditorial: '' };
  const active = session.start(ctx);
  session.appendTurn({ role: 'listener', kind: 'request', text: 'Please play something energetic.' });
  const reason = agenticLeaningsSelectionReason({ replacement: guestTrack, djName: 'X', basis: 'classical', musicalReason: 'its strings add a delicate texture to the sequence' });
  session.appendTurn({ role: 'dj', kind: 'pick', text: reason, meta: { title: guestTrack.title, artist: guestTrack.artist } });
  session.appendTurn({ role: 'dj', kind: 'pick', text: 'Leanings: jazz', meta: { title: 'Another Choice', artist: 'Another Artist' } });
  session.appendTurn({ role: 'dj', kind: 'pick', text: 'Charles’ taste for soul', meta: { title: 'Last Choice', artist: 'Last Artist' } });
  session.appendTurn({ role: 'event', kind: 'pick', text: 'Now playing Guest Choice. Choose another track.' });
  const before = JSON.stringify(session.windowMessages());
  assert.doesNotMatch(before, /classical|jazz|soul|taste|Leanings:/i);
  assert.match(before, /Guest Choice/);
  assert.match(before, /Please play something energetic/);
  assert.ok(active.messages.some((turn) => turn.text === reason), 'operator history retains the attributed reason');
  await settings.update({ personas: settings.get().personas.map((persona) => ({ ...persona, musicLean: '' })) });
  const legacy = { ...active, messages: active.messages.map(({ meta, ...turn }) =>
    turn.role === 'dj' && turn.kind === 'pick' ? turn : { ...turn, meta }) };
  writeFileSync(config.session.currentFile, JSON.stringify(legacy));
  assert.equal((await session.recover(ctx)).id, active.id);
  assert.doesNotMatch(JSON.stringify(session.windowMessages()), /classical|jazz|soul|taste|Leanings:/i);
  session.appendTurn({ role: 'listener', kind: 'request', text: 'Tell me about the next song.' });
  assert.doesNotMatch(JSON.stringify(session.windowMessages()), /classical|jazz|soul|taste|Leanings:/i);
  assert.equal(leaningsBlindPickReason('A steady pulse opens up the arrangement.', guestTrack), 'A steady pulse opens up the arrangement.');
});
