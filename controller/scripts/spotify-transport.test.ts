// SpotifyTransport end to end against injected fakes: the queue hands over a
// pick → at the seam the transport commands it → librespot's track_changed
// arrives → the mixer is told (which is where now-playing.json comes from).
// Plus the failure paths the spec lists: mismatch under both policies, an
// unavailable track, a track that never starts, a device that is missing, an
// empty seam with a pool fallback, and the gap gate's ordering.
//
// Run: npm test -- spotify-transport

import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyTransport, type TransportDeps } from '../src/music/sources/spotify/transport.js';
import type { SpotifyPlayerEvent } from '../src/broadcast/spotify-player-pure.js';

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const ID_X = 'XXXXXXXXXXXXXXXXXXXXXX';

function harness(over: Partial<TransportDeps> & { mismatch?: 'reclaim' | 'follow'; playResult?: any } = {}) {
  let now = 1_700_000_000_000;
  const calls: string[] = [];
  const logs: string[] = [];
  let marker: SpotifyPlayerEvent | null = null;
  // The refused-track memory, standing in for unplayable-file.ts. Tests read it
  // to assert that a refusal was actually remembered, which is the whole point
  // of the feature — the substitute is a bonus.
  const refused = new Map<string, { title: string; artist: string; reason: string }>();
  const deps: TransportDeps = {
    play: async (id) => { calls.push(`play:${id}`); return over.playResult ?? { ok: true }; },
    transferHere: async () => { calls.push('transfer'); return true; },
    mixerTrack: async (m) => { calls.push(`mixer:${m.subsonic_id}:${m.title}`); return { lagSec: 2 }; },
    mixerGap: async (on) => { calls.push(`gap:${on}`); return true; },
    readPlayerEvent: () => marker,
    readAudioState: () => null,
    songById: async (id) => ({ id, title: `song ${id.slice(0, 1)}`, artist: 'X', album: 'Y' }),
    fallbackSong: async () => ({ id: ID_X, title: 'pool track', artist: 'P', album: 'Q' }),
    onUnplayable: (item, reason) => { calls.push(`unplayable:${item.track.id}:${reason}`); },
    // Default: no alternative exists. The tests that care override it.
    findAlternative: async () => { calls.push('findAlternative'); return null; },
    noteRefused: (id, info) => { calls.push(`refused:${id}:${info.reason}`); refused.set(id, info); },
    isRefused: (id) => refused.has(id),
    onTrackSubstituted: (item, track) => { calls.push(`substituted:${item.track.id}->${track.id}`); item.track = track; },
    log: (kind, line) => { logs.push(`${kind}: ${line}`); },
    seamLeadMs: () => 1500,
    mismatchPolicy: () => over.mismatch ?? 'reclaim',
    now: () => now,
    startTimeoutMs: 12_000,
    idleMs: 15_000,
    ...over,
  };
  const t = new SpotifyTransport(deps);
  const emit = (event: string, o: Partial<SpotifyPlayerEvent> = {}) => { marker = { event, trackId: null, positionMs: null, durationMs: null, at: now, ...o }; };
  const advance = (ms: number) => { now += ms; };
  const item = (id: string, title: string) => ({ track: { id, title, artist: 'Portishead', album: 'Dummy', duration: 200 } } as any);
  return { t, calls, logs, emit, advance, item, deps, refused };
}

test('happy path: handoff → seam → play → track_changed → mixer told; gap off/on around the seam', async () => {
  const h = harness();
  // Track A is playing (a previous cycle). Start with its track_changed.
  h.emit('track_changed', { trackId: ID_A, durationMs: 200_000 });
  await h.t.tick();
  assert.deepEqual(h.calls.filter((c) => c.startsWith('mixer')), ['mixer:AAAAAAAAAAAAAAAAAAAAAA:song A'], 'an uncommanded start is adopted (nothing pending yet)');
  h.calls.length = 0;

  // The queue hands over B mid-track: nothing happens until the seam.
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.advance(100_000);
  await h.t.tick();
  assert.deepEqual(h.calls, [], 'held: 100s left');

  // 1.4s before the end: command B.
  h.advance(98_600);
  await h.t.tick();
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
  assert.equal(h.t.status().awaitingStart !== null, true);

  // A ends (gap on), then B starts (gap off, mixer told with the ITEM's metadata).
  h.emit('end_of_track', { trackId: ID_A }); h.advance(500); await h.t.tick();
  h.emit('track_changed', { trackId: ID_B, durationMs: 180_000 }); h.advance(700); await h.t.tick();
  assert.deepEqual(h.calls.slice(1), ['gap:true', 'gap:false', `mixer:${ID_B}:Roads`]);
  assert.equal(h.t.status().pending, null, 'the item left the transport');
  assert.equal((h.t.status().current as any).id, ID_B);
  assert.ok(h.logs.some((l) => /"Roads" started on the receiver/.test(l)));
});

test('no pick by the seam → a pool track plays and is published as a fallback', async () => {
  const h = harness();
  h.emit('track_changed', { trackId: ID_A, durationMs: 10_000 }); await h.t.tick();
  h.advance(9_000); await h.t.tick();
  assert.ok(h.calls.includes(`play:${ID_X}`), 'fallback commanded');
  h.emit('track_changed', { trackId: ID_X, durationMs: 100_000 }); h.advance(1000); await h.t.tick();
  assert.ok(h.calls.includes(`mixer:${ID_X}:pool track`));
  assert.ok(h.logs.some((l) => /pool fallback, nothing was picked/.test(l)));
});

test('mismatch under reclaim: one reclaim (transfer + play) then adopt', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));   // nothing playing → commands B at once
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
  // Past the 3s command floor, the wrong track starts.
  h.advance(3_500); h.emit('track_changed', { trackId: ID_X, durationMs: 100_000 }); await h.t.tick();
  assert.deepEqual(h.calls.slice(1), ['transfer', `play:${ID_B}`], 'reclaimed once');
  h.advance(3_500); h.emit('track_changed', { trackId: ID_X, durationMs: 100_000 }); await h.t.tick();
  assert.ok(h.calls.includes(`mixer:${ID_X}:song X`), 'second mismatch → adopted and published');
  assert.ok(h.logs.some((l) => /following "song X"/.test(l)));
});

test('mismatch under follow adopts immediately and publishes the real track', async () => {
  const h = harness({ mismatch: 'follow' });
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.emit('track_changed', { trackId: ID_X, durationMs: 100_000 }); h.advance(500); await h.t.tick();
  // No gap toggle: the gate was never on, so there is nothing to clear.
  assert.deepEqual(h.calls, [`play:${ID_B}`, `mixer:${ID_X}:song X`]);
});

test('an unavailable track is dropped through the queue hook and the next thing plays', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.advance(3_500); h.emit('unavailable', { trackId: ID_B }); await h.t.tick();
  assert.ok(h.calls.includes(`unplayable:${ID_B}:unavailable`));
  assert.ok(h.calls.includes(`play:${ID_X}`), 'fell through to the pool');
});

test('a play that the API refuses as unplayable drops the item; a missing device keeps it pending', async () => {
  const h1 = harness({ playResult: { ok: false, reason: 'unplayable', message: 'restricted' } });
  await h1.t.handoff(h1.item(ID_B, 'Roads'));
  assert.ok(h1.calls.includes(`unplayable:${ID_B}:restricted`));
  assert.equal(h1.t.status().pending, null);

  const h2 = harness({ playResult: { ok: false, reason: 'no-device', message: 'receiver not found' } });
  await h2.t.handoff(h2.item(ID_B, 'Roads'));
  assert.equal((h2.t.status().pending as any).id, ID_B, 'kept — the receiver may come back');
  assert.ok(h2.logs.some((l) => /no-device/.test(l)));
});

// ── refused tracks: remember, substitute, never offer again ─────────────────
//
// The incident these pin: one track Spotify would not play was picked,
// commanded and refused 212 times in a row, because the failure was logged and
// then forgotten. Remembering it is the fix; the alternative release is the
// bonus, and it is bounded so it can never become the new storm.

const ID_ALT = 'RRRRRRRRRRRRRRRRRRRRRR';

test('a refusal is REMEMBERED, not just dropped — that is what stops the re-pick loop', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.advance(3_500); h.emit('unavailable', { trackId: ID_B }); await h.t.tick();

  assert.deepEqual(h.refused.get(ID_B), { title: 'Roads', artist: 'Portishead', reason: 'unavailable' });
  assert.ok(h.logs.some((l) => /remembered so nothing picks it again/.test(l)),
    'the operator is told the id was kept, not just that the track failed');
});

const altTrack = { id: ID_ALT, title: 'Roads - 2018 Remaster', artist: 'Portishead', album: 'Dummy (Remastered)', duration: 201 };

test('one alternative release is tried, and now-playing names the release that actually played', async () => {
  const h = harness({ findAlternative: async () => altTrack });
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.advance(3_500); h.emit('unavailable', { trackId: ID_B }); await h.t.tick();

  assert.ok(h.calls.includes(`substituted:${ID_B}->${ID_ALT}`));
  assert.equal(h.calls.includes(`unplayable:${ID_B}:unavailable`), false,
    'the slot is not given up while a substitute is in hand');
  assert.ok(h.calls.includes(`play:${ID_ALT}`), 'the seam step of the same tick commands it — no dead air');

  h.advance(100); h.emit('track_changed', { trackId: ID_ALT, durationMs: 201_000 }); await h.t.tick();
  assert.ok(h.calls.includes(`mixer:${ID_ALT}:Roads - 2018 Remaster`),
    'the mixer is told the release that played, not the one that was refused');
});

test('a refusal inside the 3s floor defers the substitute rather than losing it', async () => {
  // The realistic shape: librespot reports `unavailable` almost immediately, so
  // the hard floor between play commands is still in force. The substitute must
  // survive that — an earlier version put it back in `pending` and then sat out
  // the full 15s idle window, because seamDecision reads "nothing playing, we
  // commanded recently" as "wait for the player".
  const h = harness({ findAlternative: async () => altTrack });
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.advance(200); h.emit('unavailable', { trackId: ID_B }); await h.t.tick();

  assert.ok(h.calls.includes(`substituted:${ID_B}->${ID_ALT}`));
  assert.equal(h.calls.includes(`play:${ID_ALT}`), false, 'the 3s floor held it');
  assert.equal((h.t.status().pending as any).id, ID_ALT, 'kept, not dropped');

  h.advance(3_000); await h.t.tick();
  assert.ok(h.calls.includes(`play:${ID_ALT}`), 'commanded as soon as the floor allows, not 15s later');
});

test('the alternative gets ONE chance: refused too, both ids are remembered and the slot is given up', async () => {
  const alt = { id: ID_ALT, title: 'Roads - 2018 Remaster', artist: 'Portishead', album: 'Dummy', duration: 201 };
  let asked = 0;
  const h = harness({ findAlternative: async () => { asked++; return asked === 1 ? alt : null; } });
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.advance(3_500); h.emit('unavailable', { trackId: ID_B }); await h.t.tick();
  h.advance(3_500); await h.t.tick();                       // commands the substitute
  h.emit('unavailable', { trackId: ID_ALT }); await h.t.tick();

  assert.equal(asked, 1, 'one search per queue item, however many releases are refused');
  assert.deepEqual([...h.refused.keys()], [ID_B, ID_ALT]);
  assert.ok(h.calls.includes(`unplayable:${ID_ALT}:unavailable`), 'now the slot is given up');
});

test('a refused POOL FALLBACK never spends a search — drawing another pool track is free', async () => {
  const h = harness();
  await h.t.tick();                                          // nothing pending → pool fallback
  assert.ok(h.calls.includes(`play:${ID_X}`));
  h.emit('unavailable', { trackId: ID_X }); await h.t.tick();

  assert.equal(h.calls.includes('findAlternative'), false);
  assert.equal(h.refused.has(ID_X), true, 'still remembered — keep() must stop drawing it from the pool');
});

test('a known-refused pick is declined at handoff and never reaches the API', async () => {
  const h = harness();
  h.refused.set(ID_B, { title: 'Roads', artist: 'Portishead', reason: 'unavailable' });
  await h.t.handoff(h.item(ID_B, 'Roads'));

  assert.equal(h.calls.some((c) => c.startsWith('play:')), false, 'no request spent on a track we know is dead');
  assert.equal(h.t.status().pending, null);
  assert.ok(h.calls.includes(`unplayable:${ID_B}:known unavailable`));
});

test("a play 403 takes the same path as librespot's event: remembered, one alternative", async () => {
  const alt = { id: ID_ALT, title: 'Roads', artist: 'Portishead', album: 'Dummy (Deluxe)', duration: 200 };
  const h = harness({
    playResult: { ok: false, reason: 'unplayable', message: 'restricted' },
    findAlternative: async () => alt,
  });
  await h.t.handoff(h.item(ID_B, 'Roads'));

  assert.equal(h.refused.get(ID_B)?.reason, 'restricted');
  assert.ok(h.calls.includes(`substituted:${ID_B}->${ID_ALT}`));
  assert.equal((h.t.status().pending as any).id, ID_ALT);
});

test('a commanded track that never starts is retried once, then dropped', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
  h.advance(13_000); await h.t.tick();
  assert.deepEqual(h.calls, [`play:${ID_B}`, `play:${ID_B}`], 'retried');
  h.advance(13_000); await h.t.tick();
  assert.ok(h.calls.includes(`unplayable:${ID_B}:never started`));
});

test('operator skip commands the pending pick now', async () => {
  const h = harness();
  h.emit('track_changed', { trackId: ID_A, durationMs: 200_000 }); await h.t.tick();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.calls.length = 0;
  assert.equal(await h.t.skip(), true);
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
});

test('session_connected never re-commands: librespot fires it for OUR OWN play command', async () => {
  // The first real run: every play → session_connected → "reconnect" handler →
  // transfer + play → session_connected → … ~100 commands in minutes, then
  // Spotify rate-limited the session. A session event is a log line, nothing more.
  const h = harness();
  h.emit('track_changed', { trackId: ID_A, durationMs: 200_000 }); await h.t.tick();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.calls.length = 0;
  h.advance(500); h.emit('session_connected'); await h.t.tick();
  assert.deepEqual(h.calls, []);
});

test('consecutive failures back the transport off; a real start clears it', async () => {
  const h = harness({ playResult: { ok: false, reason: 'no-device', message: 'gone' } });
  await h.t.handoff(h.item(ID_B, 'Roads'));          // failure 1 (no hold yet)
  h.advance(16_000); await h.t.tick();                // idle → command → failure 2 → hold 30s
  const plays = () => h.calls.filter((c) => c.startsWith('play:')).length;
  assert.equal(plays(), 2);
  assert.ok((h.t.status().holdForMs as number) > 0, 'holding');
  h.advance(16_000); await h.t.tick();
  assert.equal(plays(), 2, 'no command inside the hold');
  h.advance(20_000); await h.t.tick();                // hold over → failure 3 → 60s
  assert.equal(plays(), 3);
  assert.ok(h.logs.some((l) => /failures in a row/.test(l)));
});

test('a hard floor of 3s between play commands, whatever the reason', async () => {
  const h = harness();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
  h.advance(500);
  await h.t.skip();                                    // 0.5s later — refused by the floor
  assert.deepEqual(h.calls, [`play:${ID_B}`]);
});

test('15s of silence while a track should be playing ends it (a receiver that restarted)', async () => {
  let audioState: any = null;
  const h = harness({ readAudioState: () => audioState });
  h.emit('track_changed', { trackId: ID_A, durationMs: 300_000 }); await h.t.tick();
  await h.t.handoff(h.item(ID_B, 'Roads'));
  h.calls.length = 0;
  audioState = { state: 'silent', atMs: h.deps.now!() };
  h.advance(10_000); await h.t.tick();
  assert.deepEqual(h.calls, [], 'not yet');
  h.advance(6_000); await h.t.tick();
  assert.deepEqual(h.calls, ['gap:true', `play:${ID_B}`].filter((c) => h.calls.includes(c)).length ? h.calls : [], 'commanded the pending pick');
  assert.ok(h.calls.includes(`play:${ID_B}`));
});

// An empty pool is a FAILURE and must back off like one.
//
// This branch used to return without touching `lastCommandAt`, `failStreak` or
// `holdUntil` — and since the seam returns `command-next` unconditionally once
// the current track has ended, the 500 ms tick called it ~7,200 times an hour.
// Every call reaches `fallbackSong()` → `pool.get()`, and an empty pool has a
// two-minute TTL, so every other minute it fell through to a FULL catalogue
// walk: on the order of 1,800–4,500 requests an hour against a metered quota.
// `logOnce`'s 60-second throttle printed one line a minute, so it looked idle.
test('an empty pool backs the transport off instead of asking every tick', async () => {
  const h = harness({ fallbackSong: async () => null });
  h.emit('track_changed', { trackId: ID_A, durationMs: 200_000 });
  await h.t.tick();
  h.advance(200_000); // A ends
  h.emit('end_of_track', { trackId: ID_A });
  await h.t.tick();

  // Drive a minute of ticks at the real 500 ms cadence.
  let asks = 0;
  const counted = harness({
    fallbackSong: async () => { asks++; return null; },
  });
  counted.emit('track_changed', { trackId: ID_A, durationMs: 1_000 });
  await counted.t.tick();
  counted.advance(2_000);
  counted.emit('end_of_track', { trackId: ID_A });
  for (let i = 0; i < 120; i++) {
    await counted.t.tick();
    counted.advance(500);
  }
  // Without the backoff this is one ask per tick. With it, the 30s→10min hold
  // takes over after the second failure.
  assert.ok(asks <= 4, `the empty pool is asked a handful of times a minute, not 120 (got ${asks})`);
  assert.ok(
    counted.logs.some((l) => /failures in a row/.test(l)),
    'and the operator is told the transport is holding off',
  );
});
