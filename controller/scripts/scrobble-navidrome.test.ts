// Issue #1298: Navidrome never learned that SUB/WAVE had played anything, so
// playCount and lastPlayed stayed frozen and every `.nsp` smart playlist
// filtering on lastPlayed (the usual way to stop the Auto-DJ circling the same
// 200 tracks) had nothing to filter on.
//
// Three things are pinned here, and each one is a decision that would otherwise
// be easy to "simplify" back out:
//   1. the setting is OFF by default, so an upgrade sends nothing at all;
//   2. the Navidrome backend is NOT listener-gated, unlike Last.fm and
//      ListenBrainz — a play to an empty room still has to bump lastPlayed or
//      rotation doesn't work;
//   3. a Navidrome that refuses the call is swallowed, never thrown at the
//      caller, which is Queue.onTrackStarted.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-nav-scrobble-'));
process.env.STATE_DIR = stateRoot;
// config.ts reads these at import time; the client under test builds its URL
// from them.
process.env.NAVIDROME_URL = 'http://navidrome.test:4533';
process.env.NAVIDROME_USER = 'dj';
process.env.NAVIDROME_PASS = 'hunter2';

const {
  isEligibleScrobble,
  planNavidrome,
  elapsedSeconds,
} = await import('../src/broadcast/scrobble-pure.js');
const settings = await import('../src/settings.js');
const scrobble = await import('../src/broadcast/scrobble.js');
const listeners = await import('../src/broadcast/listeners.js');

const T0 = Date.parse('2026-01-01T12:00:00.000Z');
const started = (secondsAgo: number) => new Date(T0 - secondsAgo * 1000).toISOString();

// ── the shared eligibility rule ─────────────────────────────────────────────

test('eligibility keeps Last.fm\'s >30s / >50%-or-4min rule', () => {
  const track = { title: 'A', artist: 'B', duration: 200 };
  assert.equal(isEligibleScrobble(track, 99), false, 'under half of a 200s track');
  assert.equal(isEligibleScrobble(track, 100), true, 'exactly half counts');
  assert.equal(
    isEligibleScrobble({ title: 'A', artist: 'B', duration: 30 }, 30),
    false,
    'a 30s track is never eligible however long it ran',
  );
  assert.equal(
    isEligibleScrobble({ title: 'A', artist: 'B', duration: 900 }, 240),
    true,
    'the 4-minute floor beats the 50% rule on a long track',
  );
  // Auto-playlist tracks arrive with no duration — only the >30s floor applies.
  assert.equal(isEligibleScrobble({ title: 'A', artist: 'B' }, 29), false);
  assert.equal(isEligibleScrobble({ title: 'A', artist: 'B' }, 30), true);
  assert.equal(isEligibleScrobble({ title: '', artist: 'B', duration: 200 }, 200), false);
  assert.equal(isEligibleScrobble(null, 999), false);
});

test('elapsedSeconds floors at zero and ignores an unparseable stamp', () => {
  assert.equal(elapsedSeconds(started(90), T0), 90);
  assert.equal(elapsedSeconds(new Date(T0 + 5000).toISOString(), T0), 0);
  assert.equal(elapsedSeconds('not a date', T0), 0);
  assert.equal(elapsedSeconds(null, T0), 0);
});

// ── the Navidrome plan ──────────────────────────────────────────────────────

const basePlanInput = {
  enabled: true,
  configured: true,
  incoming: { id: 'in-1', title: 'Incoming', artist: 'Someone' },
  outgoing: { id: 'out-1', title: 'Outgoing', artist: 'Someone Else', duration: 200 },
  outgoingStartedAt: started(180),
  nowMs: T0,
};

test('the plan is empty and says why when the setting is off', () => {
  const plan = planNavidrome({ ...basePlanInput, enabled: false });
  assert.deepEqual(
    { ...plan },
    { nowPlayingId: null, submitId: null, submitAtMs: null, skip: 'navidrome scrobbling disabled' },
  );
});

test('the plan is empty when Navidrome has no credentials', () => {
  const plan = planNavidrome({ ...basePlanInput, configured: false });
  assert.equal(plan.skip, 'navidrome not configured');
  assert.equal(plan.nowPlayingId, null);
  assert.equal(plan.submitId, null);
});

test('a normal transition pings the incoming track and submits the outgoing one', () => {
  const plan = planNavidrome(basePlanInput);
  assert.equal(plan.skip, null);
  assert.equal(plan.nowPlayingId, 'in-1');
  assert.equal(plan.submitId, 'out-1');
  // The submission is stamped with when the play STARTED, not with now.
  assert.equal(plan.submitAtMs, Date.parse(basePlanInput.outgoingStartedAt));
});

test('an ineligible outgoing track is pinged-but-not-submitted', () => {
  const plan = planNavidrome({ ...basePlanInput, outgoingStartedAt: started(10) });
  assert.equal(plan.nowPlayingId, 'in-1');
  assert.equal(plan.submitId, null, 'ten seconds of a 200s track is not a play');
  assert.equal(plan.submitAtMs, null);
});

test('a track with no Navidrome id is skipped rather than guessed at', () => {
  const plan = planNavidrome({
    ...basePlanInput,
    incoming: { id: null, title: 'Untracked', artist: 'auto.m3u' },
    outgoing: { id: '  ', title: 'Untracked', artist: 'auto.m3u', duration: 200 },
  });
  assert.equal(plan.skip, null, 'the backend ran — it just had nothing addressable');
  assert.equal(plan.nowPlayingId, null);
  assert.equal(plan.submitId, null);
});

test('the first transition of a boot has no outgoing track and still pings', () => {
  const plan = planNavidrome({ ...basePlanInput, outgoing: null, outgoingStartedAt: null });
  assert.equal(plan.nowPlayingId, 'in-1');
  assert.equal(plan.submitId, null);
});

test('an unparseable start time drops the submission, not the ping', () => {
  const plan = planNavidrome({ ...basePlanInput, outgoingStartedAt: 'yesterday-ish' });
  assert.equal(plan.nowPlayingId, 'in-1');
  assert.equal(plan.submitId, null);
});

// ── the setting ─────────────────────────────────────────────────────────────

test('scrobble.navidrome.enabled defaults to false so an upgrade sends nothing', async () => {
  await settings.load();
  assert.equal(settings.get().scrobble.navidrome.enabled, false);
});

test('the setting round-trips through update() without touching its siblings', async () => {
  await settings.load();
  await settings.update({ scrobble: { navidrome: { enabled: true } } });
  assert.equal(settings.get().scrobble.navidrome.enabled, true);
  assert.equal(settings.get().scrobble.lastfm.enabled, false);
  assert.equal(settings.get().scrobble.listenbrainz.enabled, false);

  // settingsBoolLike: anything truthy saves, matching every other settings flag.
  await settings.update({ scrobble: { navidrome: { enabled: 0 } as never } });
  assert.equal(settings.get().scrobble.navidrome.enabled, false);
});

// ── the wiring, against a stubbed Navidrome ─────────────────────────────────

interface Captured { url: string; params: URLSearchParams }

async function withStubbedNavidrome(
  fn: (calls: Captured[]) => Promise<void>,
  { fail = false }: { fail?: boolean } = {},
) {
  const originalFetch = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push({ url, params: new URL(url).searchParams });
    if (fail) throw new Error('navidrome is on fire');
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// onTrackEvent is fire-and-forget by contract, so the assertions come after a
// macrotask rather than an await of the call itself.
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

const TRANSITION = {
  outgoing: { id: 'out-1', title: 'Outgoing', artist: 'Someone Else', duration: 200 },
  outgoingStartedAt: new Date(Date.now() - 180_000).toISOString(),
  incoming: { id: 'in-1', title: 'Incoming', artist: 'Someone' },
};

test('with the setting off, a transition reaches Navidrome not at all', async () => {
  await settings.load();
  await withStubbedNavidrome(async calls => {
    scrobble.onTrackEvent(TRANSITION);
    await settle();
    assert.equal(calls.length, 0);
  });
});

test('with the setting on, a transition sends nowPlaying then the scrobble', async () => {
  await settings.load();
  await settings.update({ scrobble: { navidrome: { enabled: true } } });
  // The point of the test: nobody is listening. Last.fm and ListenBrainz gate
  // on this and would skip; Navidrome must not.
  assert.equal(listeners.presentListeners(), null);

  await withStubbedNavidrome(async calls => {
    scrobble.onTrackEvent(TRANSITION);
    await settle();
    assert.equal(calls.length, 2, 'one ping for the incoming track, one submission for the outgoing');

    const [ping, submit] = calls;
    assert.match(ping.url, /\/rest\/scrobble\?/);
    assert.equal(ping.params.get('id'), 'in-1');
    assert.equal(ping.params.get('submission'), 'false');
    assert.equal(ping.params.get('time'), null, 'a now-playing ping carries no timestamp');
    // Auth rides the shared client, not a second implementation.
    assert.equal(ping.params.get('u'), 'dj');
    assert.equal(ping.params.get('c'), 'sub-wave');
    assert.ok(ping.params.get('t') && ping.params.get('s'), 'salt+token, never a plaintext password');
    assert.equal(ping.params.get('p'), null);

    assert.equal(submit.params.get('id'), 'out-1');
    assert.equal(submit.params.get('submission'), 'true');
    assert.equal(
      submit.params.get('time'),
      String(Date.parse(TRANSITION.outgoingStartedAt)),
      'Subsonic wants MILLISECONDS since epoch, and it names when the play started',
    );
  });
});

test('an ineligible outgoing track pings without submitting', async () => {
  await settings.load();
  await settings.update({ scrobble: { navidrome: { enabled: true } } });
  await withStubbedNavidrome(async calls => {
    scrobble.onTrackEvent({
      ...TRANSITION,
      outgoingStartedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.get('submission'), 'false');
  });
});

test('a Navidrome outage never reaches the caller', async () => {
  await settings.load();
  await settings.update({ scrobble: { navidrome: { enabled: true } } });
  await withStubbedNavidrome(async calls => {
    // Throws inside onTrackEvent would abort Queue.onTrackStarted mid-transition.
    assert.doesNotThrow(() => scrobble.onTrackEvent(TRANSITION));
    await settle();
    assert.equal(calls.length, 2, 'both calls were still attempted');
  }, { fail: true });
});

test.after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});
