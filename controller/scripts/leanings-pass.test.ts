// The Musical Leanings review is ONE pass shared by both selection routes
// (broadcast/dj-agent/leanings-pass.ts). These drive it with a fake model call,
// the same injection runArtistGuard uses, so the outcomes are pinned on
// behaviour rather than on the shape of dj-agent.ts's source.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-leanings-pass-'));

const { runLeaningsReview } = await import('../src/broadcast/dj-agent/leanings-pass.js');
const { NO_AGENTIC_LEANINGS_INFLUENCE } = await import('../src/broadcast/dj-agent/schemas.js');
import type { LeaningsRoute } from '../src/broadcast/dj-agent/leanings-pass.js';
import type { PickResolution } from '../src/broadcast/dj-agent/leanings-review.js';

const baseline = { id: 'baseline', title: 'Base Line', artist: 'First Artist', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 120, key: '8A', instrumental: false };
const synth = { id: 'synth', title: 'Glass Pulse', artist: 'Second Artist', energy: 'medium', moods: ['reflective'], genre: 'Synth-Pop', bpm: 121, key: '8A', instrumental: false };
const plain = { id: 'plain', title: 'Plain Song', artist: 'Third Artist', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 122, key: '8A', instrumental: false };
const seen = new Map([baseline, synth, plain].map((track) => [track.id, track]));
const editorialLeanings = { host: 'Favour synth-pop and warm voices.', guest: null, promptValue: 'Host: Favour synth-pop and warm voices.' };
const goodReason = 'its glassy synth pulse keeps the reflective sequence moving with a brighter edge';

function route(kind: LeaningsRoute['kind']): LeaningsRoute {
  return {
    kind,
    telemetry: {},
    label: kind === 'djShortlistLeaningsReview' ? 'Musical Leanings review' : 'Agentic Leanings review',
    fallback: 'using the baseline',
    failureEvent: kind === 'djShortlistLeaningsReview' ? 'shortlist.leaningsReviewFailed' : 'pick.leaningsReviewFailed',
    failureFields: kind === 'djAgentLeaningsReview' ? { agent: 'pick' } : undefined,
    replacementReason: (replacement, leaningsReason) => `[${kind}] ${replacement.id}: ${leaningsReason}`,
  };
}

async function run(answer: unknown, kind: LeaningsRoute['kind'] = 'djAgentLeaningsReview', overrides: Record<string, unknown> = {}) {
  const prompts: string[] = [];
  const logLines: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const resolution: PickResolution = {};
  const result = await runLeaningsReview({
    song: baseline,
    object: { id: baseline.id, reason: 'baseline reason', transition: 'normal' },
    seen,
    editorialLeanings,
    djName: 'Mara Vex',
    context: { link: 'No link airs for this pick.', recentTransitions: ['washout'] },
    resolution,
    route: route(kind),
    review: async (request) => {
      prompts.push(request.prompt);
      assert.equal(request.kind, kind);
      assert.equal(request.temperature, 0, 'the private review samples deterministically');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log: (line) => logLines.push(line),
    logEvent: (event, fields) => events.push([event, fields]),
    ...overrides,
  });
  return { result, resolution, prompts, logLines, events };
}

test('a verified replacement swaps the track, takes the route wording and a fresh transition', async () => {
  const { result, resolution, prompts } = await run({
    selectedId: 'synth', leaningsBasis: 'synth-pop', musicalReason: goodReason, transition: 'blend',
  });
  assert.equal(result.song.id, 'synth');
  assert.equal(result.object.id, 'synth');
  assert.equal(result.object.transition, 'blend', 'the replacement chooses its own transition');
  assert.match(result.object.reason, /^\[djAgentLeaningsReview\] synth: Mara Vex chose “Glass Pulse”/);
  assert.equal(result.reviewed, true);
  assert.equal(resolution.leaningsReview?.outcome, 'replaced');
  assert.equal(resolution.leaningsReview?.leaningsBasis, 'synth-pop');
  assert.equal(resolution.leaningsReview?.leaningsSource, 'host');
  assert.equal(resolution.leaningsReview?.baselineId, 'baseline');
  assert.match(prompts[0], /"recentTransitions"/, 'the transition ledger reaches the review');
});

test('both routes send the review the identical prompt, host/guest split included', async () => {
  const answer = { selectedId: 'baseline', leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: goodReason, transition: null };
  const agentic = await run(answer, 'djAgentLeaningsReview');
  const shortlist = await run(answer, 'djShortlistLeaningsReview');
  assert.equal(agentic.prompts[0], shortlist.prompts[0]);
  assert.match(agentic.prompts[0], /"hostLeaningsOptions"/);
  assert.match(agentic.prompts[0], /"guestLeaningsOptions"/);
});

test('keeping the baseline leaves the pick untouched but records the review', async () => {
  const { result, resolution } = await run({
    selectedId: 'baseline', leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: goodReason, transition: 'blend',
  });
  assert.equal(result.song, baseline);
  assert.equal(result.object.reason, 'baseline reason');
  assert.equal(result.object.transition, 'normal', 'a kept pick keeps its own transition');
  assert.equal(result.reviewed, true);
  assert.equal(resolution.leaningsReview?.outcome, 'kept');
  assert.equal(resolution.leaningsReview?.leaningsBasis, null);
});

test('an id outside the reviewed set is rejected and logged in the route wording', async () => {
  const { result, resolution, logLines } = await run(
    { selectedId: 'invented', leaningsBasis: 'synth-pop', musicalReason: goodReason, transition: null },
    'djShortlistLeaningsReview',
  );
  assert.equal(result.song, baseline);
  assert.equal(resolution.leaningsReview?.outcome, 'invalid');
  assert.equal(resolution.leaningsReview?.rejectionReason, 'unknown-candidate');
  assert.equal(resolution.leaningsReview?.proposedReplacementId, 'invented');
  assert.deepEqual(logLines, ['Musical Leanings review rejected (unknown-candidate) — using the baseline']);
});

test('a replacement without supported evidence is refused', async () => {
  const { result, resolution } = await run({
    selectedId: 'plain', leaningsBasis: 'synth-pop', musicalReason: goodReason, transition: null,
  });
  assert.equal(result.song, baseline);
  assert.equal(resolution.leaningsReview?.outcome, 'invalid');
  assert.equal(resolution.leaningsReview?.rejectionReason, 'basis-not-supported-by-candidate');
});

test('a failed review keeps the baseline, spends no step and emits the route failure event', async () => {
  const { result, resolution, events, logLines } = await run(new Error('provider down'));
  assert.equal(result.song, baseline);
  assert.equal(result.reviewed, false);
  assert.equal(resolution.leaningsReview?.outcome, 'failed');
  assert.equal(events[0][0], 'pick.leaningsReviewFailed');
  assert.equal(events[0][1].agent, 'pick');
  assert.equal(events[0][1].candidates, 3);
  assert.deepEqual(logLines, ['Agentic Leanings review failed — using the baseline']);
});

test('no Leanings, or nothing to compare, means no model call at all', async () => {
  const noLeanings = await run(null, 'djAgentLeaningsReview', { editorialLeanings: { host: null, guest: null, promptValue: null } });
  assert.equal(noLeanings.prompts.length, 0);
  assert.equal(noLeanings.resolution.leaningsReview?.outcome, 'not-run');
  const alone = await run(null, 'djAgentLeaningsReview', { seen: new Map([[baseline.id, baseline]]) });
  assert.equal(alone.prompts.length, 0);
  assert.equal(alone.result.reviewed, false);
});

// Live lunchtime reproduction: the reviewer swapped rock for rock on every
// turn, although the initial pick already supported the claimed preference.
for (const kind of ['djAgentLeaningsReview', 'djShortlistLeaningsReview'] as const) {
  const rock = { ...baseline, genre: 'Hard Rock' };
  const peer = { ...plain, genre: 'Alternative Rock' };
  const punk = { ...synth, genre: 'Rock, Punk' };
  const preferences = { host: 'Favour rock and punk.', guest: null, promptValue: 'Host: Favour rock and punk.' };

  test(`${kind}: an equally supported rock challenger keeps the baseline without a model call`, async () => {
    const { result, resolution, prompts } = await run(
      { selectedId: peer.id, leaningsBasis: 'rock', musicalReason: goodReason, transition: 'blend' },
      kind,
      { song: rock, seen: new Map([rock, peer].map(track => [track.id, track])), editorialLeanings: preferences },
    );
    assert.equal(prompts.length, 0);
    assert.equal(result.song, rock);
    assert.equal(result.object.reason, 'baseline reason');
    assert.equal(result.object.transition, 'normal');
    assert.equal(result.reviewed, false);
    assert.equal(resolution.leaningsReview?.outcome, 'not-run');
    assert.equal(resolution.leaningsReview?.replacementId, null);
  });

  test(`${kind}: a distinguishing punk preference can still settle a close rock choice`, async () => {
    const { result, resolution, prompts } = await run(
      { selectedId: punk.id, leaningsBasis: 'punk', musicalReason: goodReason, transition: 'blend' },
      kind,
      { song: rock, seen: new Map([rock, peer, punk].map(track => [track.id, track])), editorialLeanings: preferences },
    );
    assert.equal(result.song, punk);
    assert.equal(resolution.leaningsReview?.outcome, 'replaced');
    assert.equal(resolution.leaningsReview?.leaningsBasis, 'punk');
    const payload = JSON.parse(prompts[0].split('\n\n')[0]);
    assert.deepEqual(payload.baseline.leaningsMatches, ['rock']);
    const challenger = payload.challengers.find((candidate: { id: string }) => candidate.id === punk.id);
    assert.deepEqual(challenger.leaningsMatches, ['rock', 'punk']);
    assert.deepEqual(challenger.leaningsAdvantages, ['punk']);
  });

  test(`${kind}: the controller rejects a model swap based on an already shared preference`, async () => {
    const { result, resolution, prompts } = await run(
      { selectedId: peer.id, leaningsBasis: 'ROCK', musicalReason: goodReason, transition: 'blend' },
      kind,
      { song: rock, seen: new Map([rock, peer, punk].map(track => [track.id, track])), editorialLeanings: preferences },
    );
    assert.equal(prompts.length, 1, 'a genuine punk advantage makes a review worthwhile');
    assert.equal(result.song, rock, 'the answer cannot use a shared rock match to replace the baseline');
    assert.equal(result.object.reason, 'baseline reason');
    assert.equal(result.object.transition, 'normal');
    assert.equal(resolution.leaningsReview?.outcome, 'invalid');
    assert.equal(resolution.leaningsReview?.rejectionReason, 'basis-already-supported-by-baseline');
  });

  test(`${kind}: a distant preference match cannot start a review or displace the baseline`, async () => {
    const distant = { ...punk, energy: 'high', moods: ['workout'], bpm: 75, key: '2B' };
    const { result, prompts } = await run(
      { selectedId: distant.id, leaningsBasis: 'punk', musicalReason: goodReason, transition: 'blend' },
      kind,
      { song: rock, seen: new Map([rock, distant].map(track => [track.id, track])), editorialLeanings: preferences },
    );
    assert.equal(prompts.length, 0);
    assert.equal(result.song, rock);
  });

  test(`${kind}: a supported advantage never obliges the reviewer to swap`, async () => {
    const { result, resolution, prompts } = await run(
      { selectedId: rock.id, leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: goodReason, transition: 'blend' },
      kind,
      { song: rock, seen: new Map([rock, punk].map(track => [track.id, track])), editorialLeanings: preferences },
    );
    assert.equal(prompts.length, 1);
    assert.equal(result.song, rock);
    assert.equal(result.object.transition, 'normal');
    assert.equal(resolution.leaningsReview?.outcome, 'kept');
  });
}

// Evening station reproductions: evidence stays private to the review, and
// weak-flow matches cannot crowd viable preferences out of the reserved slots.
for (const kind of ['djAgentLeaningsReview', 'djShortlistLeaningsReview'] as const) {
  const preferences = { host: 'Favour techno and synth-pop.', guest: null, promptValue: 'Host: Favour techno and synth-pop.' };
  const base = { ...baseline, genre: 'Electronic' };
  const trance = { ...plain, genre: 'Trance' };

  test(`${kind}: stored tags support review without changing discovery candidates`, async () => {
    const candidates = new Map([base, trance].map(track => [track.id, track]));
    const before = structuredClone([...candidates.values()]);
    const lookups: string[] = [];
    const { result, resolution, prompts } = await run(
      { selectedId: trance.id, leaningsBasis: 'techno', musicalReason: goodReason, transition: 'blend' }, kind,
      {
        song: base, seen: candidates, editorialLeanings: preferences,
        lastfmTagsFor: (id: string) => { lookups.push(id); return id === trance.id ? ['trance', 'techno'] : null; },
      },
    );
    assert.equal(result.song, trance, 'guards receive the original candidate');
    assert.equal(resolution.leaningsReview?.outcome, 'replaced');
    assert.deepEqual([...candidates.values()], before);
    assert.ok(lookups.includes(base.id) && lookups.includes(trance.id));
    const payload = JSON.parse(prompts[0].split('\n\n')[0]);
    assert.deepEqual(payload.challengers[0].leaningsAdvantages, ['techno']);
    assert.equal(payload.challengers[0].lastfm_tags, undefined, 'raw tags do not inflate the model prompt');
  });

  test(`${kind}: stored baseline tags prevent a false preference advantage`, async () => {
    const { result, resolution, prompts } = await run(null, kind, {
      song: base, seen: new Map([base, trance].map(track => [track.id, track])), editorialLeanings: preferences,
      lastfmTagsFor: () => ['techno'],
    });
    assert.equal(prompts.length, 0);
    assert.equal(result.song, base);
    assert.equal(resolution.leaningsReview?.outcome, 'not-run');
  });

  test(`${kind}: shared stored tags are rejected when another advantage opens review`, async () => {
    const challenger = { ...trance, lastfm_tags: ['synth-pop'] };
    const { result, resolution, prompts } = await run(
      { selectedId: challenger.id, leaningsBasis: 'techno', musicalReason: goodReason, transition: 'blend' }, kind,
      {
        song: base, seen: new Map([base, challenger].map(track => [track.id, track])), editorialLeanings: preferences,
        lastfmTagsFor: () => ['techno'],
      },
    );
    assert.equal(prompts.length, 1);
    assert.equal(result.song, base);
    assert.equal(resolution.leaningsReview?.rejectionReason, 'basis-already-supported-by-baseline');
    const payload = JSON.parse(prompts[0].split('\n\n')[0]);
    assert.deepEqual(payload.challengers[0].leaningsAdvantages, ['synth-pop']);
  });

  test(`${kind}: viable evidence reaches review ahead of stronger weak-flow matches`, async () => {
    const ordinary = [1, 2, 3].map(n => ({ ...base, id: `ordinary-${n}`, artist: `Ordinary ${n}` }));
    const weak = [1, 2].map(n => ({ ...base, id: `weak-${n}`, genre: 'Techno, Synth-Pop', energy: 'low', moods: ['calm'], bpm: 50, key: '3B', instrumental: true }));
    const viable = { ...base, id: 'viable', genre: 'Techno', bpm: 105, key: '3B' };
    const { result, resolution, prompts } = await run(
      { selectedId: viable.id, leaningsBasis: 'techno', musicalReason: goodReason, transition: 'normal' }, kind,
      { song: base, seen: new Map([base, ...ordinary, ...weak, viable].map(track => [track.id, track])), editorialLeanings: preferences },
    );
    assert.equal(prompts.length, 1);
    assert.equal(result.song, viable);
    assert.equal(resolution.leaningsReview?.outcome, 'replaced');
    const payload = JSON.parse(prompts[0].split('\n\n')[0]);
    const evidence = payload.challengers.find((candidate: { id: string }) => candidate.id === viable.id);
    assert.ok(evidence);
    assert.ok(['close', 'possible'].includes(evidence.flowCloseness));
    assert.deepEqual(evidence.leaningsAdvantages, ['techno']);
  });
}
