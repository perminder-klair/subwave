// Cutting a FADE ending at its AUDIBLE end (transitions.fadeAudibleEnd).
//
// The silence trim cuts at the ABSOLUTE floor (the analyzer's SILENCE_DBFS,
// -50 dBFS). On a fade that floor lands seconds after the music stopped being
// audible, and the exit crossfade (sized from the wind-down, then pulled to an
// 8 s floor on a sung tail and bar-snapped) then overlaps a near-silent tail:
// on production a fade aired its whole crossfade at -47 dBFS and the next
// track rose from silence. With the setting on, a fade ending is cut where
// the tail's short-term loudness curve (tail v3, outro.loudnessCurve) last
// reaches N dB under the track's own loudness, and the exit canvas spans the
// wind-down up to that point.
//
// Pinned here:
//   - the E computation (music/loudness-curve.ts): threshold edges, no
//     qualifying point, malformed curves;
//   - the resolver (music/silence-trim.ts, the one owner of every cue point):
//     off is byte-identical, on cuts at E even with the silence trim off,
//     never past the end the trim gives, never at/before cueIn + 1 s, only on
//     a fade, and playableSpanSec counts it through the same path;
//   - the settings: cold-load round trip, lenient load coercion, strict
//     update, no mixer restart;
//   - the exit canvas (music/mix.ts endingCrossSecondsFor) on the audible-end
//     path: clamp 6..12, no vocal floor, no tail-drop shaping, no bar snap,
//     operator ceiling and the E - cueIn - 1 bound;
//   - outro_json parsing keeps a valid curve and drops a malformed one.

import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { coldLoadSettings } from './test-utils/settings.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-fade-audible-end-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { resolveSilenceTrim, playableSpanSec, resolveAudibleEnd } = await import('../src/music/silence-trim.js');
const { audibleEndSec, parseLoudnessCurve } = await import('../src/music/loudness-curve.js');
const { endingCrossSecondsFor } = await import('../src/music/mix.js');
const { parseOutroJson } = await import('../src/music/library-db/rows.js');

// A curve from 200.0 s, every 0.5 s: level L(t) in LUFS, stored in tenths.
function curveOf(levels: number[], startMs = 200_000) {
  return { startMs, stepMs: 500, lufs: levels.map(l => Math.round(l * 10)) };
}

// Body -10 LUFS. Held at -12 until 210 s, then down 2 dB per 0.5 s, with the
// point at 212.0 s exactly at -30.0 (body - 20) and 212.5 s at -30.1.
//   200.0 … 210.0 → -12 (21 points), then -14 … at 210.5 …
const LEVELS: number[] = [];
for (let t = 200; t <= 210; t += 0.5) LEVELS.push(-12);
LEVELS.push(-20, -26, -28, -30, -30.1, -36, -42, -48, -55, -60, -65, -70);
// index of 212.0 s: (212 - 200) / 0.5 = 24
assert.equal(LEVELS[24], -30);

const FADE = {
  id: undefined as string | undefined,
  duration: 220,
  leadSilenceMs: 3_000,
  tailSilenceMs: 2_730,
  tailStartMs: 217_270,
  loudnessLufs: -10,
  outro: { startMs: 205_300, ending: 'fade' as const, loudnessCurve: curveOf(LEVELS) },
};

async function coldLoad(stored: Record<string, unknown>) {
  await coldLoadSettings(stored);
}

// ── E computation ────────────────────────────────────────────────────────────

test('E is the LAST point at or above body - N, in seconds', () => {
  const c = parseLoudnessCurve(curveOf(LEVELS))!;
  assert.equal(audibleEndSec(c, -10, 20), 212, 'a point exactly at the threshold qualifies');
  // -30.1 is under -30: one tenth below does not.
  assert.equal(audibleEndSec(c, -9.95, 20), 211.5, 'threshold -29.95: 212.0 (-30.0) no longer qualifies');
  assert.equal(audibleEndSec(c, -10, 15), 210.5, 'a smaller N cuts earlier');
  assert.equal(audibleEndSec(c, -10, 35), 213.5, 'a larger N cuts later');
  // The LAST qualifying point, not the first under: a level that dips and
  // comes back is still audible at the later point.
  const bump = parseLoudnessCurve(curveOf([-12, -40, -40, -25, -40, -50]))!;
  assert.equal(audibleEndSec(bump, -10, 20), 201.5);
});

test('no qualifying point → null', () => {
  const c = parseLoudnessCurve(curveOf([-40, -45, -50]))!;
  assert.equal(audibleEndSec(c, -10, 20), null);
  assert.equal(audibleEndSec(parseLoudnessCurve(curveOf([]))!, -10, 20), null, 'empty curve');
  assert.equal(audibleEndSec(c, Number.NaN, 20), null, 'unknown body loudness');
  assert.equal(audibleEndSec(c, null, 20), null, 'no body loudness at all');
  assert.equal(audibleEndSec(c, Number.NEGATIVE_INFINITY, 20), null, 'a broken body loudness');
  assert.equal(audibleEndSec(c, -10, Number.NaN), null, 'an unreadable dial');
});

test('a malformed curve is dropped whole, never repaired', () => {
  assert.deepEqual(parseLoudnessCurve(curveOf([-12, -20])), { startMs: 200_000, stepMs: 500, lufs: [-120, -200] });
  for (const bad of [
    null, 'x', [], {},
    { startMs: 'a', stepMs: 500, lufs: [] },
    { startMs: -1, stepMs: 500, lufs: [] },
    { startMs: 1000, stepMs: 0, lufs: [] },
    { startMs: 1000, stepMs: 500, lufs: 'x' },
    // One bad point would shift every later point's time if dropped alone.
    { startMs: 1000, stepMs: 500, lufs: [-100, 'x', -120] },
    { startMs: 1000, stepMs: 500, lufs: [-100, null] },
    { startMs: 1000, stepMs: 500, lufs: [-100, Number.POSITIVE_INFINITY] },
  ]) {
    assert.equal(parseLoudnessCurve(bad), null, JSON.stringify(bad));
  }
});

test('outro_json keeps a valid curve and drops a malformed one', () => {
  const base = { startMs: 205_300, ending: 'fade', lufs: -20, bpm: 100, beats: [1], bars: [1] };
  const kept = parseOutroJson(JSON.stringify({ ...base, loudnessCurve: curveOf([-12, -30]) }))!;
  assert.deepEqual(kept.loudnessCurve, { startMs: 200_000, stepMs: 500, lufs: [-120, -300] });
  const dropped = parseOutroJson(JSON.stringify({ ...base, loudnessCurve: { startMs: 1, stepMs: 500, lufs: [1, 'x'] } }))!;
  assert.equal(dropped.startMs, 205_300, 'the outro itself survives a bad curve');
  assert.equal('loudnessCurve' in dropped, false, 'a malformed curve is absent, not null');
  const none = parseOutroJson(JSON.stringify(base))!;
  assert.equal('loudnessCurve' in none, false, 'an older outro has no curve key');
});

// ── settings ─────────────────────────────────────────────────────────────────

test('absent/malformed settings coerce to off and 20 dB', async () => {
  await coldLoad({});
  assert.equal(settings.get().transitions.fadeAudibleEnd, false);
  assert.equal(settings.get().transitions.fadeAudibleEndDb, 20);
  await coldLoad({ transitions: { fadeAudibleEnd: 'yes', fadeAudibleEndDb: 'loud' } });
  assert.equal(settings.get().transitions.fadeAudibleEnd, false);
  assert.equal(settings.get().transitions.fadeAudibleEndDb, 20);
  for (const db of [14.9, 35.1, -20, Number.NaN, null, '25']) {
    await coldLoad({ transitions: { fadeAudibleEndDb: db } });
    assert.equal(settings.get().transitions.fadeAudibleEndDb, 20, String(db));
  }
});

test('both keys survive a cold load', async () => {
  await coldLoad({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 27.5 } });
  assert.equal(settings.get().transitions.fadeAudibleEnd, true);
  assert.equal(settings.get().transitions.fadeAudibleEndDb, 27.5);
  await coldLoad({ transitions: { fadeAudibleEndDb: 15 } });
  assert.equal(settings.get().transitions.fadeAudibleEndDb, 15, 'the lower bound is allowed');
  await coldLoad({ transitions: { fadeAudibleEndDb: 35 } });
  assert.equal(settings.get().transitions.fadeAudibleEndDb, 35, 'the upper bound is allowed');
});

test('update is strict, saves, survives a restart, and needs no mixer restart', async () => {
  await coldLoad({});
  for (const bad of [
    { fadeAudibleEndDb: 14 },
    { fadeAudibleEndDb: 36 },
    { fadeAudibleEndDb: 'abc' },
    { fadeAudibleEndDb: '20' },
    { fadeAudibleEndDb: null },
    { fadeAudibleEnd: 'yes' },
    { fadeAudibleEnd: 1 },
  ]) {
    await assert.rejects(settings.update({ transitions: bad } as never), /fadeAudibleEnd/, JSON.stringify(bad));
  }
  const { requiresRestart } = await settings.prepareUpdate({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 25 } } as never);
  assert.equal(requiresRestart, false, 'not a liquidsoap_*.txt setting');
  await settings.update({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 25 } } as never);
  assert.equal(settings.get().transitions.fadeAudibleEnd, true);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().transitions.fadeAudibleEnd, true, 'survives the restart');
  assert.equal(settings.get().transitions.fadeAudibleEndDb, 25);
  // A patch without the keys leaves them alone.
  await settings.update({ transitions: { pairDrain: true } } as never);
  assert.equal(settings.get().transitions.fadeAudibleEnd, true);
  assert.equal(settings.get().transitions.fadeAudibleEndDb, 25);
});

// ── resolver ─────────────────────────────────────────────────────────────────

test('off: byte-identical to the silence trim alone', async () => {
  await coldLoad({ silenceTrim: { enabled: true, minGapMs: 1_500 } });
  assert.deepEqual(resolveSilenceTrim(FADE), { cueInSec: 2.75, cueOutSec: 217.52 });
  assert.equal(playableSpanSec(FADE), 214.77);
  assert.equal(resolveAudibleEnd(FADE), null);
  await coldLoad({});
  assert.deepEqual(resolveSilenceTrim(FADE), { cueInSec: null, cueOutSec: null });
  assert.equal(playableSpanSec(FADE), 220);
  assert.equal(resolveAudibleEnd(FADE), null);
});

test('on, with the silence trim on: cut at E, the head kept as trimmed', async () => {
  await coldLoad({ silenceTrim: { enabled: true, minGapMs: 1_500 }, transitions: { fadeAudibleEnd: true } });
  assert.deepEqual(resolveSilenceTrim(FADE), { cueInSec: 2.75, cueOutSec: 212 });
  assert.deepEqual(resolveAudibleEnd(FADE), { endSec: 212, cueInSec: 2.75 });
  assert.equal(playableSpanSec(FADE), 209.25, 'every forecast sees the shorter track');
});

test('on, with the silence trim OFF: still cut at E (its own switch)', async () => {
  await coldLoad({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 20 } });
  assert.deepEqual(resolveSilenceTrim(FADE), { cueInSec: null, cueOutSec: 212 });
  assert.equal(playableSpanSec(FADE), 212);
  await coldLoad({ transitions: { fadeAudibleEnd: true, fadeAudibleEndDb: 15 } });
  assert.equal(resolveSilenceTrim(FADE).cueOutSec, 210.5, 'the dial moves the cut');
});

test('on: nothing changes without a qualifying point, a fade, a curve or a body loudness', async () => {
  await coldLoad({ silenceTrim: { enabled: true, minGapMs: 1_500 }, transitions: { fadeAudibleEnd: true } });
  const base = { cueInSec: 2.75, cueOutSec: 217.52 };
  const cases: Array<[string, object]> = [
    ['all below', { outro: { ...FADE.outro, loudnessCurve: curveOf([-40, -45]) } }],
    ['cold ending', { outro: { ...FADE.outro, ending: 'cold' } }],
    ['no curve', { outro: { startMs: 205_300, ending: 'fade' } }],
    ['malformed curve', { outro: { ...FADE.outro, loudnessCurve: { startMs: 200_000, stepMs: 500, lufs: [-120, 'x'] } } }],
    ['no outro', { outro: null }],
    ['no body loudness', { loudnessLufs: null }],
  ];
  for (const [name, patch] of cases) {
    const t = { ...FADE, ...patch };
    assert.deepEqual(resolveSilenceTrim(t), base, name);
    assert.equal(resolveAudibleEnd(t), null, name);
    assert.equal(playableSpanSec(t), 214.77, name);
  }
});

test('on: E at or after the trimmed end changes nothing', async () => {
  await coldLoad({ silenceTrim: { enabled: true, minGapMs: 1_500 }, transitions: { fadeAudibleEnd: true } });
  // Audible right up to 217.5 s: E = 217.5 s is before 217.52 → applies.
  const late = { ...FADE, outro: { ...FADE.outro, loudnessCurve: curveOf([...Array(36).fill(-12)]) } };
  assert.equal(resolveSilenceTrim(late).cueOutSec, 217.5);
  // …up to 218.0 s: past the trimmed end → the trim's own cut stands.
  const later = { ...FADE, outro: { ...FADE.outro, loudnessCurve: curveOf([...Array(37).fill(-12)]) } };
  assert.equal(resolveSilenceTrim(later).cueOutSec, 217.52);
  assert.equal(resolveAudibleEnd(later), null);
  // Trim off: compared with the file's own end (220 s) instead.
  await coldLoad({ transitions: { fadeAudibleEnd: true } });
  assert.equal(resolveSilenceTrim(later).cueOutSec, 218);
  const pastEnd = { ...FADE, outro: { ...FADE.outro, loudnessCurve: curveOf([...Array(41).fill(-12)]) } };
  assert.equal(resolveSilenceTrim(pastEnd).cueOutSec, null, 'E = 220 s is not before the end');
});

test('on: never at or before cueIn + 1 s', async () => {
  await coldLoad({ silenceTrim: { enabled: true, minGapMs: 1_500 }, transitions: { fadeAudibleEnd: true } });
  // cueIn 2.75 → the cut must land after 3.75 s.
  const early = (endPoint: number) => ({
    ...FADE,
    outro: { ...FADE.outro, loudnessCurve: { startMs: 3_000, stepMs: 250, lufs: [...Array(endPoint + 1).fill(-120), -900, -900] } },
  });
  // last audible point at 3.0 + 3 * 0.25 = 3.75 s → refused (at cueIn + 1).
  assert.equal(resolveSilenceTrim(early(3)).cueOutSec, 217.52);
  assert.equal(resolveAudibleEnd(early(3)), null);
  // …at 4.0 s → allowed.
  assert.equal(resolveSilenceTrim(early(4)).cueOutSec, 4);
});

test('E is rounded to whole ms', async () => {
  await coldLoad({ transitions: { fadeAudibleEnd: true } });
  const odd = { ...FADE, outro: { ...FADE.outro, loudnessCurve: { startMs: 200_000.4, stepMs: 333.3333, lufs: [-120, -120, -900] } } };
  assert.equal(resolveSilenceTrim(odd).cueOutSec, 200.334);
});

// ── exit canvas ──────────────────────────────────────────────────────────────

test('exit canvas on the audible-end path: clamp 6..12, no floor, no shaping, no snap', () => {
  const fade = { bpm: 120, key: null, ending: 'fade' as const };
  const ae = (endSec: number, cueInSec: number | null = 0) => ({ endSec, cueInSec });
  // 212 - 205.3 = 6.7 s: no 8 s floor, and at 120 BPM a bar is 2 s, so the
  // old path would have snapped it to 8.
  assert.equal(endingCrossSecondsFor(fade, 6.7, { audibleEnd: ae(212) }), 6.7);
  assert.equal(endingCrossSecondsFor(fade, 6.7, {}), 8, 'the old path for contrast');
  // A sung tail would pull the old path to 8; the audible path ignores it.
  assert.equal(endingCrossSecondsFor(fade, 6.7, { vocalTail: true, audibleEnd: ae(212) }), 6.7);
  // Tail-drop shaping would pull toward 8; ignored too.
  assert.equal(endingCrossSecondsFor(fade, 10.3, { tailLufs: -12, bodyLufs: -10, audibleEnd: ae(220) }), 10.3);
  // Clamp 6..12.
  assert.equal(endingCrossSecondsFor(fade, 3.2, { audibleEnd: ae(212) }), 6);
  assert.equal(endingCrossSecondsFor(fade, 0, { audibleEnd: ae(212) }), 6);
  assert.equal(endingCrossSecondsFor(fade, 15, { audibleEnd: ae(212) }), 12);
  assert.equal(endingCrossSecondsFor(fade, null, { audibleEnd: ae(212) }), 10, 'unknown wind-down: 10 s');
  // The operator's crossfade ceiling still wins.
  assert.equal(endingCrossSecondsFor(fade, 10, { maxSec: 7, audibleEnd: ae(212) }), 7);
  // Never more than E - cueIn - 1.
  assert.equal(endingCrossSecondsFor(fade, 10, { audibleEnd: ae(9.5, 1.25) }), 7.2);
  assert.equal(endingCrossSecondsFor(fade, 10, { audibleEnd: ae(9.5, null) }), 8.5);
  // A cold ending ignores it: the old 4 s, bar-snapped.
  assert.equal(endingCrossSecondsFor({ ...fade, ending: 'cold' }, 6, { audibleEnd: ae(212) }), 4);
});

// ── the queue's exit stamp ───────────────────────────────────────────────────

test('the drain stamps the audible-end canvas only when the cut applied', async () => {
  const { queue } = await import('../src/broadcast/queue.js');
  const q = queue as unknown as {
    current: unknown; upcoming: unknown[]; djLog: Array<{ kind: string; message: string }>;
    applyMixTransition(item: unknown): void;
  };
  const djMode = async (transitions: Record<string, unknown>) => {
    await coldLoad({ transitions });
    const personas = settings.get().personas.map((p, i) => (i === 0 ? { ...p, djMode: true } : p));
    await settings.update({ personas } as never);
  };
  // Outro tempo 120 BPM (2 s bars): the old path snaps, the audible one does not.
  const track = () => ({ ...FADE, id: undefined, title: 'Fade', artist: 'A', bpm: 120,
    outro: { ...FADE.outro, bpm: 120, lufs: -20, beats: null, bars: null } });
  q.current = { track: { title: 'On air', artist: 'B', duration: 300 } };

  await djMode({ fadeAudibleEnd: true });
  const cut = { track: track() } as { track: Record<string, unknown> };
  q.upcoming = [cut];
  q.applyMixTransition(cut);
  // E = 212 s, wind-down from 205.3 s: 6.7 s, under the 10 s ceiling.
  assert.equal(cut.track.crossSec, 6.7);
  assert.ok(q.djLog.some(e => e.kind === 'mix' && e.message.includes('cut at audible end 212s')));

  await djMode({ fadeAudibleEnd: false });
  const plain = { track: track() } as { track: Record<string, unknown> };
  q.upcoming = [plain];
  q.applyMixTransition(plain);
  // Off: today's canvas — the wind-down to 220 s (14.7 s) clamps to 12, then
  // the operator's 10 s ceiling.
  assert.equal(plain.track.crossSec, 10);
  const qq = queue as unknown as { _persistTimer?: NodeJS.Timeout; _recentPlaysTimer?: NodeJS.Timeout };
  if (qq._persistTimer) clearTimeout(qq._persistTimer);
  if (qq._recentPlaysTimer) clearTimeout(qq._recentPlaysTimer);
});
