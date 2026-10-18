// The transition-ask ledger and what the model is told about it.
//
// Three things regress here, each silently:
//
//  - The ANTI-STREAK strip is targeted. A third identical ask in a row loses
//    that ask and nothing else; the blanket strip it replaced also took the
//    length cap's auto-washout off a capped pick, so the forced cut aired as a
//    bare crossfade — the exact sound the auto-arm exists to prevent.
//  - The HISTORY the model sees is not one pick stale under pair-drain. The
//    ledger fills at drain, and a held head only drains after its successor is
//    picked, so the pick being built never saw the ask right before it.
//  - The agent's per-pick EFFECT CLAUSE names only the gestures left switched
//    on, and is the historical text byte for byte when all six are.

// The durable seam record (#1829): what the DJ asked for on a pick, every armed
// gesture a strip took back (with a stable reason code), and how each aired
// track came in — written to library.db `plays` and the `track.play` event when
// the track starts, and rolled up for the Stats panel.
//
// The regressions this guards are all silent ones: a strip site that forgets to
// note its drop makes the Stats card under-count with nothing wrong on air; a
// label that claims the previous song's washout after a jingle sat between them
// reports a seam that never aired; a migration that throws on a database that
// already has the columns stops library.db from opening at all.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = createTempDir(join(tmpdir(), 'subwave-seam-record-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { effectEventClause, pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const db = await import('../src/music/library-db.js');
const { TRANSITION_EFFECTS } = await import('../src/settings/vocab.js');
const { queue } = await import('../src/broadcast/queue.js');
const { seamRecordAtPlay } = await import('../src/broadcast/queue/pure.js');
const { interposedSince } = await import('../src/broadcast/queue/voice-io.js');
const { config } = await import('../src/config.js');

after(() => {
  const q = queue as any;
  if (q._persistTimer) clearTimeout(q._persistTimer);
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  library.shutdown();
});

const q = queue as any;
type Track = Record<string, unknown>;
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

async function seedDjMode(extra: Record<string, unknown> = {}, djMode = true) {
  await settings.load();
  const personas = settings.get().personas.map((p, i) => (i === 0 ? { ...p, djMode } : p));
  await settings.update({
    personas,
    maxTrackSeconds: 0,
    transitions: { pairDrain: true, effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, true])) },
    ...extra,
  });
}

// One DJ pick drained behind an on-air track. `onAir` lets a test give the
// pair measured tempo/key, which is what the pair-fit vetoes judge.
function drain(track: Track, { ledger = [] as string[], onAir = {} as Track, aiPicked = true } = {}) {
  q.current = { track: { id: 'on-air', title: 'On air', artist: 'A', duration: 300, ...onAir } };
  q.djLog = [];
  q._recentEffects = [...ledger];
  const pick: { aiPicked?: boolean; track: Track } = { ...(aiPicked ? { aiPicked: true } : {}), track: { id: 'pick', title: 'Pick', artist: 'B', ...track } };
  q.upcoming = [pick];
  queue.applyMixTransition(pick as never);
  return pick;
}

const markers = {
  jingle: () => config.liquidsoap.jinglePlayingFile,
  bed: () => config.liquidsoap.bedPlayingFile,
  break: () => config.liquidsoap.pauseTalkPlayingFile,
};
function clearMarkers() {
  for (const f of Object.values(markers)) rmSync(f(), { force: true });
}
// Liquidsoap stamps startedAt as unix SECONDS.
function marker(kind: keyof typeof markers, atMs: number) {
  writeFileSync(markers[kind](), JSON.stringify({ filename: `/x/${kind}.wav`, startedAt: atMs / 1000 }));
}

// --- the label rule -------------------------------------------------------

test('the seam label shares the dashboard\'s precedence, and an interposed clip owns the seam', () => {
  const out = (track: Track) => ({ track });
  const inc = (track: Track, extra: Track = {}) => ({ track, sent: true, ...extra });

  assert.deepEqual(seamRecordAtPlay(out({ washout: true }), inc({ sweep: true }), null),
    { label: 'Washout + Sweep', stranded: [] }, 'exit and entry both ride the seam');
  assert.deepEqual(seamRecordAtPlay(out({ loop: true }), inc({ sweep: true }), null),
    { label: 'Loop', stranded: [] }, 'a loop suppresses every entry gesture, as in radio.liq');
  assert.deepEqual(seamRecordAtPlay(out({ showFade: true, washout: true }), inc({ chop: true }), null),
    { label: 'Normal', stranded: [] }, 'a show-boundary cut airs as a plain fade');
  assert.deepEqual(seamRecordAtPlay(out({}), inc({}, { stemSeam: true }), null),
    { label: 'Stem blend', stranded: [] });
  assert.deepEqual(seamRecordAtPlay(null, inc({ sweep: true }), null),
    { label: null, stranded: [] }, 'no known predecessor (first track after boot) records nothing');

  // A jingle between the songs: the mixer stands the entry gestures down, and
  // the previous song's exit went into the jingle, not into this track.
  assert.deepEqual(seamRecordAtPlay(out({ washout: true }), inc({ sweep: true, blend: true }), 'jingle'),
    { label: 'After jingle', stranded: ['sweep', 'blend'] });
  // A bed or a break: their drain paths already stripped the entry gestures.
  assert.deepEqual(seamRecordAtPlay(out({ washout: true }), inc({}), 'bed'), { label: 'After bed', stranded: [] });
  assert.deepEqual(seamRecordAtPlay(out({}), inc({}), 'break'), { label: 'After break', stranded: [] });
});

// --- what sat between two songs ---------------------------------------------

test('interposedSince reads the newest marker stamped after the previous song started', () => {
  clearMarkers();
  const now = Date.now();
  const prev = now - 240_000;
  assert.equal(interposedSince(prev, now), null, 'no markers on disk');

  marker('jingle', prev - 60_000);
  assert.equal(interposedSince(prev, now), null, 'a marker from before the previous song is the file surviving');

  marker('bed', now - 20_000);
  assert.equal(interposedSince(prev, now), 'bed');
  marker('jingle', now - 5_000);
  assert.equal(interposedSince(prev, now), 'jingle', 'the latest of several wins');

  marker('break', now + 60_000);
  assert.equal(interposedSince(prev, now), 'jingle', 'a marker from the future is ignored');

  writeFileSync(markers.bed(), '{not json');
  assert.equal(interposedSince(prev, now), 'jingle', 'an unreadable marker counts as nothing');
  assert.equal(interposedSince(Number.NaN, now), null, 'an unknown previous start interposes nothing');
  clearMarkers();
});

// --- the drain records the ask and the drops ---------------------------------

test('a drained DJ pick records its ask once, and each strip notes a reason code', async () => {
  await seedDjMode();
  // Identical tempo and key: a sweep across a locked pair is vetoed.
  const locked = { bpm: 120, musicalKey: '8A' };
  const pick = drain({ sweep: true, ...locked }, { onAir: locked });
  assert.equal(pick.track.sweep, undefined);
  assert.equal(pick.track.transitionAsk, 'sweep', 'the ask is what the DJ chose, before the strip');
  assert.deepEqual(pick.track.mixDrops, [{ effect: 'sweep', reason: 'pair-fit' }]);

  // A drain retry re-runs the strips: the record must not double.
  queue.applyMixTransition(pick as never);
  assert.equal(pick.track.transitionAsk, 'sweep');
  assert.equal((pick.track.mixDrops as unknown[]).length, 1, 'idempotent per effect + reason');
});

test('switched off, repeat rule and no predecessor each carry their own code', async () => {
  await seedDjMode({ transitions: { effects: { dissolve: false } } });
  const off = drain({ dissolve: true });
  assert.deepEqual(off.track.mixDrops, [{ effect: 'dissolve', reason: 'switched-off' }]);
  assert.equal(off.track.transitionAsk, 'dissolve');

  await seedDjMode();
  const repeat = drain({ chop: true }, { ledger: ['chop', 'chop'] });
  assert.deepEqual(repeat.track.mixDrops, [{ effect: 'chop', reason: 'variety' }]);

  q.current = null;
  q.djLog = [];
  const cold = { aiPicked: true, track: { id: 'cold', title: 'Cold', artist: 'C', washout: true } };
  q.upcoming = [cold];
  queue.applyMixTransition(cold as never);
  assert.deepEqual((cold.track as Track).mixDrops, [{ effect: 'washout', reason: 'no-predecessor' }]);
});

test('the cap\'s auto-washout is recorded as auto when a show-boundary cut takes it', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const pick = drain({ duration: 900 });
  assert.equal(pick.track.washoutAuto, true, 'the cap armed its washout');
  assert.equal(pick.track.transitionAsk, 'normal', 'the DJ asked for nothing; the auto-arm is no ask');
  queue.applyBoundaryStamps(pick as never, { cueOutSec: 100 } as never);
  assert.deepEqual(pick.track.mixDrops, [{ effect: 'washout', reason: 'show-boundary', auto: true }]);
});

test('a plain station records no asks', async () => {
  await seedDjMode({}, false);
  const pick = drain({});
  assert.equal(pick.track.transitionAsk, undefined, 'DJ mode off and no flag: the choice was never offered');
  assert.equal(pick.track.mixDrops, undefined);
  // A flag left from before DJ mode flipped off is still the DJ's ask.
  const stale = drain({ sweep: true });
  assert.equal(stale.track.transitionAsk, 'sweep');
  assert.deepEqual(stale.track.mixDrops, [{ effect: 'sweep', reason: 'dj-mode-off' }]);
});

// --- the track start writes it ------------------------------------------------

function eventLines(type: string): Array<Record<string, unknown>> {
  const dir = join(root, 'logs');
  return readdirSync(dir).filter(f => f.startsWith('events-'))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
    .filter(e => e.type === type);
}

async function airPick(id: string, track: Track, interposeJingle = false) {
  clearMarkers();
  const prevStartedMs = Date.now() - 240_000;
  q.lastSeenKey = null;
  q.current = {
    track: { id: `prev-${id}`, title: `Prev ${id}`, artist: 'A', washout: true },
    startedAt: new Date(prevStartedMs).toISOString(),
  };
  if (interposeJingle) marker('jingle', Date.now() - 10_000);
  q.upcoming = [{ sent: true, aiPicked: true, track: { id, title: `Song ${id}`, artist: 'B', ...track } }];
  // Record the real boundary without starting an unrelated background model pick.
  const autoPick = queue.autoPick;
  queue.autoPick = false;
  try {
    queue.onTrackStarted({ title: `Song ${id}`, artist: 'B', subsonic_id: id } as never);
    await settle();
  } finally {
    queue.autoPick = autoPick;
  }
  clearMarkers();
  return db.listPlays({ limit: 200 }).rows.find(r => r.trackId === id);
}

test('a track start writes the seam record to the play row and the track.play event', async () => {
  await seedDjMode();
  const row = await airPick('rec-1', { sweep: true, transitionAsk: 'sweep' });
  assert.ok(row, 'the play was recorded');
  assert.equal(row.transition, 'Washout + Sweep', 'the previous song\'s exit plus this pick\'s entry');
  assert.equal(row.transitionAsk, 'sweep');
  assert.equal(row.transitionDrops, null, 'nothing was dropped');

  const ev = eventLines('track.play').find(e => e.title === 'Song rec-1');
  assert.ok(ev, 'the timeline carries it too');
  assert.equal(ev.transition, 'Washout + Sweep');
  assert.equal(ev.transitionAsk, 'sweep');
});

test('a jingle between the songs strands the entry gesture and labels the seam', async () => {
  await seedDjMode();
  const row = await airPick('rec-2', {
    chop: true, transitionAsk: 'chop',
    mixDrops: [{ effect: 'washout', reason: 'show-boundary' }],
  }, true);
  assert.ok(row);
  assert.equal(row.transition, 'After jingle', 'neither the washout nor the chop rode this seam');
  assert.deepEqual(row.transitionDrops, [
    { effect: 'washout', reason: 'show-boundary' },
    { effect: 'chop', reason: 'jingle-seam' },
  ], 'drain-time drops are kept, and the mixer-side one is added at play');
});

// --- the rollup and the schema ----------------------------------------------

test('transitionStats rolls up the window, skipping legacy rows and older plays', async () => {
  await library.load();
  const d = db.getDb()!;
  d.prepare('DELETE FROM plays').run();
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
  const base = { trackId: null, title: 't', artist: 'a', album: null, source: 'ai', requestedBy: null, showId: null, showName: null };
  db.recordPlay({ ...base, playedAt: at(10), transition: 'Sweep', transitionAsk: 'sweep' });
  db.recordPlay({ ...base, playedAt: at(20), transition: 'Normal', transitionAsk: 'chop',
    transitionDrops: [{ effect: 'chop', reason: 'pair-fit' }] });
  db.recordPlay({ ...base, playedAt: at(30), transition: 'After jingle', transitionAsk: 'blend',
    transitionDrops: [{ effect: 'blend', reason: 'jingle-seam' }, { effect: 'washout', reason: 'show-boundary', auto: true }] });
  db.recordPlay({ ...base, playedAt: at(40), source: 'request' });                       // legacy shape: all null
  db.recordPlay({ ...base, playedAt: at(60 * 24 * 9), transition: 'Sweep', transitionAsk: 'sweep' }); // outside 7 days
  d.prepare('UPDATE plays SET transition_drops = ? WHERE played_at = ?').run('{broken', at(40));

  const s = db.transitionStats(7);
  assert.equal(s.seams, 3);
  assert.deepEqual(s.bySeam, { 'Sweep': 1, 'Normal': 1, 'After jingle': 1 });
  assert.equal(s.asked, 3);
  assert.deepEqual(s.byAsk, { sweep: 1, chop: 1, blend: 1 });
  assert.equal(s.dropped, 3);
  assert.deepEqual(s.byReason, { 'pair-fit': 1, 'jingle-seam': 1, 'show-boundary': 1 });
  assert.deepEqual(s.byEffect, { chop: { 'pair-fit': 1 }, blend: { 'jingle-seam': 1 }, washout: { 'show-boundary': 1 } });

  const legacy = db.listPlays({ limit: 200 }).rows.find(r => r.source === 'request');
  assert.equal(legacy?.transitionDrops, null, 'a malformed drops column reads as none, not a failed listing');
});

test('the v28 migration adds the columns, and re-running it on a database that has them is harmless', async () => {
  await library.load();
  const cols = () => (db.getDb()!.prepare('PRAGMA table_info(plays)').all() as Array<{ name: string }>).map(c => c.name);
  for (const c of ['transition', 'transition_ask', 'transition_drops']) assert.ok(cols().includes(c), `${c} exists`);
  assert.equal(db.getDb()!.pragma('user_version', { simple: true }), 28);

  // Wound back below the step with the columns still present (a downgrade, a
  // hand repair): the step must add only what is missing, not throw.
  db.getDb()!.pragma('user_version = 27');
  library.shutdown();
  await library.load();
  assert.equal(db.getDb()!.pragma('user_version', { simple: true }), 28);
  assert.equal(cols().filter(c => c.startsWith('transition')).length, 3);
});

// Transition ask ledger and prompt visibility.
const mixLines = () => (q.djLog as Array<{ kind: string; message: string }>)
  .filter(e => e.kind === 'mix').map(e => e.message);

test('a capped pick whose ask is the third sweep keeps the cap\'s auto-washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, sweep: true }, { ledger: ['sweep', 'sweep'], aiPicked: false }).track;
  assert.equal(track.sweep, undefined, 'the repeated ask is stripped');
  assert.equal(track.washout, true, 'the forced cut still echoes out');
  assert.equal(track.washoutAuto, true, 'as the cap\'s own washout, not a model choice');
  assert.ok(mixLines().includes('sweep dropped (variety — third sweep in a row)'));
  assert.ok(mixLines().some(l => l.startsWith('washout armed (length-cap exit)')),
    'and the booth log says the washout is the cap\'s');
  assert.deepEqual(q._recentEffects, ['sweep', 'sweep', 'sweep'], 'the ask still counts toward the streak');
});

test('a capped pick whose ask is the third washout airs it as the cap\'s washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, washout: true }, { ledger: ['washout', 'washout'], aiPicked: false }).track;
  assert.equal(track.washout, true, 'the cap would have armed it anyway');
  assert.equal(track.washoutAuto, true, 'so it comes back as the deterministic auto-arm');
  assert.ok(mixLines().includes('washout dropped (variety — third washout in a row)'));
  assert.equal(q._recentEffects.at(-1), 'washout', 'the model\'s ask is what the ledger recorded');
});

test('a capped pick whose ask is the third loop falls back to the cap\'s washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, bpm: 120, loop: true }, { ledger: ['loop', 'loop'], aiPicked: false }).track;
  assert.equal(track.loop, undefined);
  assert.equal(track.washoutAuto, true, 'the stripped loop no longer keeps the auto-arm off');
});

test('a capped loop with no measured tempo also falls back to the cap\'s washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, loop: true }, { ledger: [], aiPicked: false }).track;
  assert.equal(track.loop, undefined, 'a loop needs a bar length');
  assert.equal(track.washoutAuto, true, 'and the cut is not left bare');
});

test('an armed loop on a capped pick still keeps the auto-washout off', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, bpm: 120, loop: true }, { ledger: ['sweep', 'normal'], aiPicked: false }).track;
  assert.equal(track.loop, true);
  assert.equal(track.washout, undefined, 'the loop already owns that ending');
});

test('the re-armed cap washout still honours the washout switch', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  await settings.update({ transitions: { effects: { washout: false } } });
  const track = drain({ duration: 900, sweep: true }, { ledger: ['sweep', 'sweep'], aiPicked: false }).track;
  assert.equal(track.sweep, undefined);
  assert.equal(track.washout, undefined, 'switched off means a plain crossfade, even on a capped exit');
});

test('an uncapped third sweep loses only the sweep, never the washout beside it', async () => {
  await seedDjMode();
  const track = drain({ duration: 300, sweep: true, washout: true }, { ledger: ['sweep', 'sweep'], aiPicked: false }).track;
  assert.equal(track.sweep, undefined, 'the counted ask goes');
  assert.equal(track.washout, true, 'the exit gesture on the same pick stays');
  assert.equal(track.washoutAuto, undefined, 'and stays the model\'s');
});

test('the history shows the held head\'s ask before it drains, and only once after', async () => {
  await seedDjMode();
  q.current = { track: { id: 'on-air', title: 'On air', artist: 'A', duration: 300 } };
  q._recentEffects = ['sweep', 'normal'];
  const held = { track: { id: 'held', title: 'Held', artist: 'B', duration: 300, washout: true }, aiPicked: true, sent: false };
  const request = { track: { id: 'req', title: 'Request', artist: 'C', duration: 300 }, requestedBy: 'listener', sent: false };
  q.upcoming = [held, request];

  assert.deepEqual(queue.recentTransitionChoices(), ['sweep', 'normal', 'washout'],
    'the held pick\'s ask is visible; the request is not invented as one');
  assert.deepEqual(q._recentEffects, ['sweep', 'normal'], 'reading it never touches the ledger itself');

  queue.applyMixTransition(held as never);
  assert.deepEqual(queue.recentTransitionChoices(), ['sweep', 'normal', 'washout'],
    'once the drain has ledgered it, the still-unsent item is not counted twice');
  held.sent = true;
  assert.deepEqual(queue.recentTransitionChoices(), ['sweep', 'normal', 'washout']);

  q._recentEffects = ['blend', 'normal', 'sweep', 'chop'];
  q.upcoming = [{ track: { id: 'x', title: 'X', artist: 'D', duration: 300, dissolve: true }, aiPicked: true, sent: false }];
  assert.deepEqual(queue.recentTransitionChoices(), ['normal', 'sweep', 'chop', 'dissolve'],
    'capped at the ledger\'s own length, newest kept');
});

test('a pair-drain pick event shows the model the held head\'s ask', async () => {
  await seedDjMode({ llm: { pickerAgent: true, dailyTokenCap: 0 } });
  const onAir = { id: 'on-air', title: 'On air', artist: 'Someone Else', duration: 300 };
  const held = { id: 'held', title: 'Held Head', artist: 'Held Artist', duration: 300, washout: true };
  const agentPick = { id: 'agent-pick', title: 'Next Pick', artist: 'Third Artist', duration: 300 };

  q.current = { track: onAir, source: 'ai' };
  q.upcoming = [{ track: held, aiPicked: true, sent: false, queuedAt: new Date().toISOString() }];
  q.history = [];
  q.djLog = [];
  q._recentPlays = [];
  q._recentEffects = ['sweep', 'normal'];
  // The pushed pick's fire-and-forget drain must not touch Liquidsoap's files.
  q.senderBusy = true;

  const realRun = (pickerAgent as any).run;
  let eventPrompt: string | null = null;
  (pickerAgent as any).run = async ({ messages }: { messages: Array<{ content: string }> }) => {
    eventPrompt = messages.at(-1)?.content ?? null;
    return {
      object: { id: agentPick.id, reason: 'A change of pace.', say: null, transition: 'normal' },
      steps: 1,
      toolCalls: [],
      extras: { seen: new Map([[agentPick.id, agentPick]]) },
    };
  };
  try {
    const ctx = { activeShow: null, clock: {}, time: { period: 'day' }, dominantMood: null };
    session.start(ctx as any);
    await runTrackEvent(queue, ctx, { wantLink: false, pickAnchor: held, anchorPrior: onAir });
  } finally {
    (pickerAgent as any).run = realRun;
    q.senderBusy = false;
  }
  assert.match(eventPrompt ?? '', /Your recent transition choices, oldest first: sweep, normal, washout —/,
    'the ask of the pick this one follows is in the turn that picks it');
});

const ALL_ON = ' Set "transition" by what THIS moment needs, per the TRANSITION EFFECTS guidance — "washout"/"loop" end your pick, "sweep"/"dissolve"/"chop" resolve a clash, "blend" only for an exceptionally locked pair, "normal" otherwise. Vary your craft: never the same transition three picks running, and if your last pick used an effect, lean "normal" now unless the moment clearly calls again.';

test('the per-pick effect clause names only the gestures left switched on', async () => {
  await seedDjMode();
  assert.equal(effectEventClause(), ALL_ON, 'all six on is the historical text byte for byte');
  assert.equal(effectEventClause(' NOTE'), `${ALL_ON} NOTE`, 'the history note rides on the end');

  await settings.update({ transitions: { effects: { sweep: false, dissolve: false, chop: false } } });
  const noClash = effectEventClause();
  assert.match(noClash, /— "washout"\/"loop" end your pick, "blend" only for an exceptionally locked pair, "normal" otherwise\./);
  assert.doesNotMatch(noClash, /resolve a clash|"sweep"|"dissolve"|"chop"/, 'a switched-off gesture is never offered');

  await settings.update({ transitions: { effects: { washout: false } } });
  assert.match(effectEventClause(), /— "loop" end your pick, "blend" only/);

  await settings.update({ transitions: { effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, false])) } });
  assert.equal(effectEventClause(' NOTE'), '', 'nothing left on reads exactly like DJ mode off');

  await settings.update({ transitions: { effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, true])) } });
  const personas = settings.get().personas.map(p => ({ ...p, djMode: false }));
  await settings.update({ personas });
  assert.equal(effectEventClause(), '', 'and DJ mode off is still no clause at all');
});
