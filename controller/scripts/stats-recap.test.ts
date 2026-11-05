// The Stats page's weekly recap (src/stats-recap.ts): the last seven complete
// UTC days against the seven before, with a figure null rather than zero when
// its record does not reach back to the start of its window.
import assert from 'node:assert/strict';
import test from 'node:test';

const { buildWeekRecap } = await import('../src/stats-recap.js');

// Fri 30 Oct 2026, 00:03 UTC: the week is Fri 23 – Thu 29, the one before 16 – 22.
const NOW = Date.parse('2026-10-30T00:03:00Z');
const at = (iso: string) => iso;

function day(date: string, sessions: number, referrers: Record<string, number> = {}, countries: Record<string, number> = {}) {
  return { date, sessions, referrers, countries };
}

function play(playedAt: string, artist: string | null, title: string | null, requestedBy: string | null = null) {
  return { playedAt, artist, title, requestedBy };
}

const base = { now: NOW, station: 'Klair Radio', days: [], samples: [], requests: [], plays: [] };

test('frames the last seven complete UTC days', () => {
  const r = buildWeekRecap(base);
  assert.deepEqual(r.week, { from: '2026-10-23', to: '2026-10-29', number: 43 });
  assert.equal(r.station, 'Klair Radio');
});

test('totals each window, and compares only against a week the records cover', () => {
  const r = buildWeekRecap({
    ...base,
    days: [
      day('2026-10-16', 10, {}, { GB: 4, US: 6 }),
      day('2026-10-22', 5, {}, { DE: 5 }),
      day('2026-10-23', 20, {}, { GB: 10, US: 9, XX: 0 }),
      day('2026-10-29', 4, {}, { CA: 4 }),
      day('2026-10-30', 99, {}, { FR: 99 }), // today: outside both windows
    ],
    plays: [
      play('2026-10-16T08:00:00Z', 'A', 'a1'),
      play('2026-10-24T08:00:00Z', 'A', 'a1'),
      play('2026-10-25T08:00:00Z', 'B', 'b1'),
    ],
    requests: [
      { t: '2026-10-16T09:00:00Z', requester: 'anon' },
      { t: '2026-10-26T09:00:00Z', requester: 'Goofy' },
      { t: '2026-10-27T09:00:00Z', requester: 'Goofy' },
    ],
  });
  assert.deepEqual(
    { sessions: r.current.sessions, countries: r.current.countries, tracks: r.current.tracks, requests: r.current.requests },
    { sessions: 24, countries: 3, tracks: 2, requests: 2 },
  );
  assert.deepEqual(
    { sessions: r.previous.sessions, countries: r.previous.countries, tracks: r.previous.tracks, requests: r.previous.requests },
    { sessions: 15, countries: 3, tracks: 1, requests: 1 },
  );
});

test('a station younger than two weeks has no week before to compare', () => {
  const r = buildWeekRecap({
    ...base,
    days: [day('2026-10-20', 3), day('2026-10-24', 8)],
    samples: [{ t: at('2026-10-24T10:00:00Z'), count: 2 }],
    plays: [play('2026-10-21T08:00:00Z', 'A', 'a1')],
    requests: [{ t: '2026-10-25T09:00:00Z', requester: 'x' }],
  });
  assert.equal(r.current.sessions, 8);
  assert.equal(r.previous.sessions, null);
  assert.equal(r.previous.listeningHours, null);
  assert.equal(r.previous.tracks, null);
  assert.equal(r.previous.requests, null);
});

test('play-based figures are unmeasured while library.db is closed', () => {
  const r = buildWeekRecap({ ...base, plays: null });
  assert.equal(r.current.tracks, null);
  assert.equal(r.topArtist, null);
  assert.deepEqual(r.mostPlayed.artists, []);
});

test('listening hours are listener-minutes over 60, and the busiest clock hour is the highest mean', () => {
  const samples: { t: string; count: number }[] = [];
  for (let m = 0; m < 60; m++) samples.push({ t: new Date(Date.parse('2026-10-29T21:00:00Z') + m * 60_000).toISOString(), count: 6 });
  for (let m = 0; m < 30; m++) samples.push({ t: new Date(Date.parse('2026-10-24T08:00:00Z') + m * 60_000).toISOString(), count: 2 });
  samples.push({ t: '2026-10-30T00:01:00Z', count: 50 }); // today
  const r = buildWeekRecap({ ...base, samples });
  assert.equal(r.current.listeningHours, 7); // (60×6 + 30×2) / 60
  assert.deepEqual(r.busiestHour, { at: '2026-10-29T21:00:00.000Z', avg: 6 });
});

test('top artist counts its requested plays; top requester leaves anonymous requests out', () => {
  const r = buildWeekRecap({
    ...base,
    plays: [
      play('2026-10-24T01:00:00Z', 'Khruangbin', 'Maria También', 'Goofy'),
      play('2026-10-24T02:00:00Z', 'Khruangbin', 'Maria También'),
      play('2026-10-24T03:00:00Z', 'Khruangbin', 'Evan Finds the Third Room'),
      play('2026-10-24T04:00:00Z', 'Bonobo', 'Kerala', 'anon'),
      play('2026-10-24T05:00:00Z', null, null),
    ],
    requests: [
      { t: '2026-10-24T01:00:00Z', requester: 'anon' },
      { t: '2026-10-24T02:00:00Z', requester: 'anon' },
      { t: '2026-10-24T03:00:00Z', requester: 'Goofy' },
    ],
  });
  assert.deepEqual(r.topArtist, { name: 'Khruangbin', plays: 3, requested: 1 });
  assert.deepEqual(r.topTrack, { title: 'Maria También', artist: 'Khruangbin', plays: 2 });
  assert.deepEqual(r.topRequester, { name: 'Goofy', requests: 1 });
});

test('a new source is a referrer first seen this week, never direct', () => {
  const r = buildWeekRecap({
    ...base,
    days: [
      day('2026-10-10', 5, { reddit: 5 }),
      day('2026-10-24', 40, { direct: 30, reddit: 2, 'selfh.st': 6 }),
      day('2026-10-27', 30, { 'selfh.st': 20, 'github.com': 3 }),
    ],
  });
  assert.deepEqual(r.newSource, { source: 'selfh.st', sessions: 26, firstSeen: '2026-10-24' });
});

test('without audience history from before the week, no source counts as new', () => {
  const r = buildWeekRecap({ ...base, days: [day('2026-10-24', 6, { 'selfh.st': 6 })] });
  assert.equal(r.newSource, null);
});

test('most played is the rolling last seven days, today included', () => {
  const r = buildWeekRecap({
    ...base,
    plays: [
      play('2026-10-20T08:00:00Z', 'Old', 'gone'),
      play('2026-10-29T23:00:00Z', 'Tycho', 'Awake'),
      play('2026-10-30T00:01:00Z', 'Tycho', 'Awake'),
      play('2026-10-30T00:02:00Z', 'Nujabes', 'Aruarian Dance'),
    ],
  });
  assert.deepEqual(r.mostPlayed.artists, [{ name: 'Tycho', plays: 2 }, { name: 'Nujabes', plays: 1 }]);
  assert.deepEqual(r.mostPlayed.tracks[0], { title: 'Awake', artist: 'Tycho', plays: 2 });
});
