// Review evidence and ordering for both picker routes. leanings-pass.test.ts
// checks the shared model call on behaviour; this file also pins placement
// after a blind baseline, before guards, and provenance after enqueue.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-agentic-leanings-review-'));

const settings = await import('../src/settings.js');
await settings.load();

const {
  agenticLeaningsReviewPrompt,
  agenticLeaningsReviewSchema,
  agenticLeaningsReviewSystem,
  NO_AGENTIC_LEANINGS_INFLUENCE,
} = await import('../src/broadcast/dj-agent/schemas.js');
const {
  agenticDiscoverySelectionReason,
  agenticSelectionReason,
  agenticLeaningsSources,
  agenticLeaningsSelectionReason,
  compactAgenticReviewCandidate,
  eligibleAgenticLeanings,
  plainAgenticSelectionReason,
  resolveAgenticLeaningsUsage,
  selectAgenticReviewCandidates,
  validateAgenticLeaningsReplacement,
  verifiedAgenticReason,
} = await import('../src/broadcast/dj-agent/leanings-review.js');

const leaningsOptions = ['warm voices', 'strong melodies'];
const schema = agenticLeaningsReviewSchema(['alternative', 'preliminary'], leaningsOptions, 'preliminary');
const editorialEvidence = {
  baselineFacts: [{ field: 'genre', value: 'Electronic' }],
  challengerFacts: [{ field: 'lastfm_tags', value: 'virtuoso' }],
  comparison: 'strong musicianship: virtuoso is more specific evidence for this preference than Electronic alone.',
};
const prompt = agenticLeaningsReviewPrompt({
  baseline: { id: 'preliminary', artist: 'First Artist', title: 'First Track' },
  challengers: [{ id: 'alternative', artist: 'Second Artist', title: 'Second Track' }],
  leaningsOptions,
  context: { djName: 'Mara Vex' },
});
const sourcedLeanings = agenticLeaningsSources({
  host: 'Favour electronic music and patient dub.',
  guest: { guest: { name: 'Carrie Marshall' }, musicalLeanings: 'Favour angular guitar and post-punk.' },
}, 'Mara Vex');
const baselineCandidate = { id: 'baseline', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 120, key: '8A', instrumental: false };
const candidatePool = [
  { id: 'far', energy: 'high', moods: ['workout'], genre: 'Metal', bpm: 75, key: '2B', instrumental: false },
  { id: 'close-b', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 121, key: '8A', instrumental: false },
  baselineCandidate,
  { id: 'close-a', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 122, key: '8A', instrumental: false },
];
const reviewedForward = selectAgenticReviewCandidates(baselineCandidate, candidatePool, [], 3).map((candidate) => candidate.id);
const reviewedReverse = selectAgenticReviewCandidates(baselineCandidate, [...candidatePool].reverse(), [], 3).map((candidate) => candidate.id);
const profileMatchPool = [
  ...candidatePool,
  { id: 'profile-match', energy: 'medium', moods: ['reflective'], genre: 'Synth-Pop', bpm: 90, key: '2B', instrumental: false },
  { id: 'ordinary-third', energy: 'medium', moods: ['reflective'], genre: 'Rock', bpm: 123, key: '8A', instrumental: false },
];
const rockBaseline = { ...baselineCandidate, genre: 'Rock' };
const crowdedPool = Array.from({ length: 8 }, (_, i) => ({ ...rockBaseline, id: `rock-${i}` }));
const distinguishingPunk = { ...rockBaseline, id: 'punk', genre: 'Punk', bpm: 121 };
const replacement = { artist: 'Buddy Holly', title: 'Rave On' };
const musicalLeanings = 'She enjoys warm voices, strong melodies, thoughtful songwriting and records that reveal themselves gradually.';
const generatedLeaningsReason = agenticLeaningsSelectionReason({
  replacement,
  djName: 'Lucy Harper',
  basis: 'strong melodies',
  musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
});
const fallbackReason = agenticSelectionReason(
  { artist: 'The Last Dinner Party', title: 'This Is the Killer Speaking' },
  'short scratchpad',
);
const mismatchedDiscoveryReason = agenticDiscoverySelectionReason(
  { artist: 'Buddy Holly', title: 'Rave On' },
  'Elliott Smith’s Rose Parade is calm and reflective, with a harmonically close key.',
);
const detailedReason = 'The Last Dinner Party — This Is the Killer Speaking: its theatrical vocal and taut guitar arrangement sharpen the current flow without abandoning its melodic thread.';
const djTasteReason = 'Magazine — Burst: its wiry post-punk guitars sharpen the transition while matching Mara Vex’s taste for angular, melodic records.';
const attributedReason = agenticLeaningsSelectionReason({ replacement: { artist: 'Magazine', title: 'Burst' }, djName: 'Mara Vex', leaningsOwnerName: 'Carrie Marshall', basis: 'post-punk', musicalReason: 'its wiry guitars add a taut but melodic turn to the sequence' });
const changedAndQueued = {
  hasLeanings: true,
  preliminaryId: 'preliminary',
  replacementId: 'alternative',
  finalId: 'alternative',
  queued: true,
};

test('Review schema repairs optional evidence and requires an ID', () => {
  assert.equal(schema.safeParse({
    selectedId: 'preliminary',
    leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE,
    musicalReason: 'its warm vocal keeps the reflective flow moving naturally',
    transition: null,
  }).success, true, 'the review can explicitly keep the preliminary pick');
  assert.equal(schema.safeParse({
    selectedId: 'preliminary',
    transition: null,
  }).success, true, 'a weak model omitting review notes is repaired to an explicit keep');
  assert.equal(schema.safeParse({
    selectedId: 'alternative',
    leaningsBasis: 'warm voices',
    musicalReason: 'its warm vocal provides a gentle lift without breaking the reflective flow',
    transition: null,
  }).success, true, 'the review can nominate an enumerated alternative');
  assert.equal(schema.parse({
    selectedId: 'alternative',
    leaningsBasis: 'invented preference',
    musicalReason: 'its warm vocal provides a gentle lift without breaking the reflective flow',
    transition: null,
  }).leaningsBasis, 'invented preference', 'free strings avoid local-model enum ordering bias; the controller validator owns the allow-list');
  assert.equal(schema.safeParse({
    selectedId: 'invented',
    leaningsBasis: 'warm voices',
    musicalReason: 'its warm vocal provides a gentle lift without breaking the reflective flow',
    transition: null,
  }).success, true, 'free ids avoid enum ordering bias; the controller rejects ids outside the compact candidate map');
  assert.equal(schema.safeParse({
    leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE,
    musicalReason: 'its warm vocal keeps the reflective flow moving naturally',
    transition: null,
  }).success, false, 'the final reviewed id remains mandatory');
  assert.deepEqual(schema.parse({ selectedId: 'preliminary', leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE,
    musicalReason: 'its reflective texture leaves room for the next musical step', transition: null }).editorialEvidence,
  null, 'older/exact-match answers safely omit the new comparison field');
  assert.deepEqual(schema.parse({ selectedId: 'alternative', leaningsBasis: 'strong melodies',
    musicalReason: 'its reflective texture leaves room for the next musical step', transition: null, editorialEvidence }).editorialEvidence,
  editorialEvidence, 'the standard structured schema preserves the bounded comparison');
  assert.equal(schema.safeParse({ selectedId: 'alternative', leaningsBasis: 'strong melodies',
    musicalReason: 'its reflective texture leaves room for the next musical step', transition: null,
    editorialEvidence: { ...editorialEvidence, challengerFacts: [{ field: 'invented', value: 'made up' }] } }).success, true,
  'malformed optional evidence falls back to null; the replacement validator still requires support');
});

test('Review prompts and phrase extraction remain explicit', () => {
  assert.match(prompt, /leaningsSources identifies the owner/i);
  assert.match(prompt, /"baseline"/i);
  assert.match(prompt, /"challengers"/i);
  assert.match(prompt, /Use this decision order/i);
  assert.match(prompt, /Do not independently rerank/i);
  assert.match(prompt, /leaningsBasis=NO_LEANINGS_INFLUENCE/i);
  assert.match(prompt, /flowCloseness="close"/i);
  assert.match(prompt, /leaningsMatches/i);
  assert.match(prompt, /leaningsAdvantages/i);
  assert.match(prompt, /keep the baseline by default/i);
  assert.match(prompt, /A matching challenger never obliges a swap/i);
  assert.match(prompt, /roughly 12–28 words/i);
  assert.match(prompt, /controller adds the verified names and exact evidence/i);
  assert.match(prompt, /beginning with "its" or "it"/i);
  assert.match(prompt, /Do not mention preferences, Leanings, baseline, challenger, preliminary choice, current flow/i);
  assert.doesNotMatch(prompt, /musicalLeanings/i, 'the compact review receives only controller-extracted exact options');
  assert.ok(agenticLeaningsReviewSystem().length < 600, 'the review uses a compact dedicated system instruction');
  assert.doesNotMatch(agenticLeaningsReviewSystem(), /Four Acres|on-air|station house/i);
});

test('Candidate scoring and compact metadata preserve ownership and flow', () => {
  assert.deepEqual(sourcedLeanings, [
    { phrase: 'electronic music', source: 'host', ownerName: 'Mara Vex' },
    { phrase: 'patient dub', source: 'host', ownerName: 'Mara Vex' },
    { phrase: 'angular guitar', source: 'guest', ownerName: 'Carrie Marshall' },
    { phrase: 'post-punk', source: 'guest', ownerName: 'Carrie Marshall' },
  ]);
  assert.deepEqual(reviewedForward, ['baseline', 'close-a', 'close-b']);
  assert.deepEqual(reviewedReverse, reviewedForward, 'challenger selection is invariant to discovery insertion order');
  assert.ok(
    selectAgenticReviewCandidates(baselineCandidate, profileMatchPool, ['synth-pop'], 5).some((candidate) => candidate.id === 'profile-match'),
    'the compact review reserves room for an exact metadata-grounded profile match',
  );
  assert.deepEqual(
    eligibleAgenticLeanings(baselineCandidate, candidatePool, sourcedLeanings).map(({ source }) => source),
    ['host', 'host'],
    'a viable host-supported choice excludes secondary guest preferences from the review',
  );
  assert.deepEqual(
    eligibleAgenticLeanings({ ...baselineCandidate, genre: 'Metal' }, [{ ...baselineCandidate, id: 'guest-match', genre: 'Post-Punk' }], sourcedLeanings).map(({ source }) => source),
    ['host', 'host', 'guest', 'guest'],
    'guest preferences remain available when the host has no supported near-flow option',
  );
  assert.deepEqual(compactAgenticReviewCandidate({ ...baselineCandidate, album: 'omitted', duration_sec: 300 }), baselineCandidate,
    'the review payload drops irrelevant token-heavy metadata');
  assert.deepEqual(
    compactAgenticReviewCandidate({ id: 'synth', genre: 'Synth-Pop', moods: ['energetic'] }, ['synth-pop', 'warm voices']),
    { id: 'synth', genre: 'Synth-Pop', moods: ['energetic'], leaningsMatches: ['synth-pop'] },
    'the controller exposes only exact candidate metadata overlaps from the active profile',
  );
  assert.deepEqual(
    compactAgenticReviewCandidate({ id: 'smart', genre: 'Smart Pop' }, ['art pop']),
    { id: 'smart', genre: 'Smart Pop' },
    'an exact phrase cannot match across a metadata word boundary',
  );
  assert.equal(
    compactAgenticReviewCandidate(candidatePool[1], [], baselineCandidate).flowCloseness,
    'close',
    'the compact payload exposes a coarse Leanings-blind flow comparison',
  );
  assert.ok(
    selectAgenticReviewCandidates(rockBaseline, [...crowdedPool, distinguishingPunk], ['rock', 'punk'])
      .some(candidate => candidate.id === 'punk'),
    'shared rock matches cannot crowd a distinguishing punk preference out of the compact review',
  );
  assert.deepEqual(
    compactAgenticReviewCandidate({ ...rockBaseline, id: 'peer', genre: 'Alternative Rock' }, ['rock'], rockBaseline).leaningsAdvantages,
    undefined,
    'a shared genre is not a preference advantage',
  );
});

test('Replacement validation requires supported evidence and a flow tie', () => {
  assert.deepEqual(validateAgenticLeaningsReplacement({
    musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
    leaningsBasis: 'strong melodies',
    musicalLeanings,
    allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
    supportedLeanings: ['strong melodies'],
    baselineSupportedLeanings: [],
    flowCloseness: 'close',
  }), { valid: true, basis: 'strong melodies', evidenceKind: 'metadata-match' });
  assert.deepEqual(validateAgenticLeaningsReplacement({
    musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
    leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE,
    musicalLeanings,
    allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
    supportedLeanings: ['strong melodies'],
    baselineSupportedLeanings: [],
    flowCloseness: 'close',
  }), { valid: false, reason: 'missing-leanings-basis' }, 'a changed id cannot use the no-influence sentinel');
  assert.deepEqual(validateAgenticLeaningsReplacement({
    musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
    leaningsBasis: 'melodic songwriting',
    musicalLeanings,
    allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
    supportedLeanings: ['strong melodies'],
    baselineSupportedLeanings: [],
    flowCloseness: 'close',
  }), { valid: false, reason: 'missing-leanings-basis' }, 'a phrase outside the controller options cannot masquerade as evidence');
  assert.deepEqual(validateAgenticLeaningsReplacement({
    musicalReason: 'too short',
    leaningsBasis: 'strong melodies',
    musicalLeanings,
    allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
    supportedLeanings: ['strong melodies'],
    baselineSupportedLeanings: [],
    flowCloseness: 'close',
  }), { valid: false, reason: 'weak-musical-reason' });
  assert.deepEqual(validateAgenticLeaningsReplacement({
    musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
    leaningsBasis: 'strong melodies',
    musicalLeanings,
    allowedLeanings: ['warm voices', 'strong melodies'],
    supportedLeanings: [],
    baselineSupportedLeanings: [],
    flowCloseness: 'close',
  }), { valid: false, reason: 'basis-not-supported-by-candidate' });
  assert.deepEqual(validateAgenticLeaningsReplacement({
    musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
    leaningsBasis: 'strong melodies',
    musicalLeanings,
    allowedLeanings: ['warm voices', 'strong melodies'],
    supportedLeanings: ['strong melodies'],
    baselineSupportedLeanings: [],
    flowCloseness: 'weak',
  }), { valid: false, reason: 'not-flow-tie' });
});

test('Displayed Leanings reasons use verified identity and clean model language', () => {
  assert.match(generatedLeaningsReason, /Lucy Harper chose “Rave On” by Buddy Holly/i);
  assert.match(generatedLeaningsReason, /Lucy Harper’s taste for strong melodies/i);
  assert.equal(
    agenticLeaningsSelectionReason({
      replacement,
      djName: 'Lucy Harper',
      basis: 'strong melodies',
      musicalReason: 'The bright melodic momentum of Rave On by Buddy Holly lifts the current flow naturally.',
    }),
    'Lucy Harper chose “Rave On” by Buddy Holly; its bright melodic momentum lifts the current sequence naturally, reflecting Lucy Harper’s taste for strong melodies.',
    'the controller removes duplicated model-written identity from the displayed rationale',
  );
  assert.equal(
    agenticLeaningsSelectionReason({
      replacement: { artist: 'Goldfrapp', title: 'You Never Know (Goldfrapp remix)' },
      djName: 'Shelby Hart',
      basis: 'electronic music',
      musicalReason: 'The Goldfrapp remix of You Never Know maintains a high-energy celebratory atmosphere, complementing the baseline.',
    }),
    'Shelby Hart chose “You Never Know (Goldfrapp remix)” by Goldfrapp; its remix maintains a high-energy, celebratory atmosphere while keeping the sequence coherent, reflecting Shelby Hart’s taste for electronic music.',
    'remix identity and internal baseline language are cleaned from a live rationale',
  );
  assert.equal(
    agenticLeaningsSelectionReason({
      replacement: { artist: 'Death Cab for Cutie', title: 'Rand McNally' },
      djName: 'Lucy Harper',
      basis: 'indie',
      musicalReason: "The reflective mood of 'Rand McNally' complements the energetic baseline with a soothing contrast.",
    }),
    'Lucy Harper chose “Rand McNally” by Death Cab for Cutie; its reflective mood brings a soothing contrast without breaking the sequence, reflecting Lucy Harper’s taste for indie.',
    'a repeated title and evaluator comparison become natural DJ rationale',
  );
  assert.equal(
    agenticLeaningsSelectionReason({
      replacement: { artist: 'Nils Frahm', title: 'Went Missing' },
      djName: 'Nathaniel Nightshade',
      basis: 'modern classical',
      musicalReason: 'The calm and reflective moods, low energy, and 117.5 BPM create a soothing atmosphere.',
    }),
    'Nathaniel Nightshade chose “Went Missing” by Nils Frahm; its calm, reflective character and steady pulse create a soothing atmosphere, reflecting Nathaniel Nightshade’s taste for modern classical.',
    'numeric metadata language is softened without losing the musical explanation',
  );
  assert.equal(
    agenticLeaningsSelectionReason({
      replacement: { artist: 'Carter the Unstoppable Sex Machine', title: 'Johnny Cash (Oxford Zodiac Soundcheck)' },
      djName: 'Lucy Harper',
      basis: 'indie',
      musicalReason: 'The energetic tempo and indie sound of Johnny Cash (Oxford Zodiac Soundcheck) complement the current flow.',
    }),
    'Lucy Harper chose “Johnny Cash (Oxford Zodiac Soundcheck)” by Carter the Unstoppable Sex Machine; its energetic tempo and distinctive sound keep the sequence moving naturally, reflecting Lucy Harper’s taste for indie.',
    'the exact Leanings phrase appears once, in the verified attribution',
  );
});

test('Agentic reasons preserve useful notes and remove unverified preferences', () => {
  assert.doesNotMatch(fallbackReason, /shortlist/i, 'Agentic fallback copy must never imply the Shortlist picker ran');
  assert.match(fallbackReason, /This Is the Killer Speaking.*The Last Dinner Party/i);
  assert.equal(
    agenticDiscoverySelectionReason(
      { artist: 'Dinosaur Jr.', title: 'Never Bought It' },
      'high energy, driving guitar riffs and a catchy melody',
    ),
    '“Never Bought It” by Dinosaur Jr. — high energy, driving guitar riffs and a catchy melody.',
    'a useful identity-free discovery explanation is safely anchored to its verified track',
  );
  assert.doesNotMatch(mismatchedDiscoveryReason, /Elliott Smith|Rose Parade/i,
    'a reason that appears to name another selection is not attached to the discovery pick');
  assert.match(mismatchedDiscoveryReason, /Rave On.*Buddy Holly/i);
  assert.equal(
    agenticSelectionReason({ artist: 'The Last Dinner Party', title: 'This Is the Killer Speaking' }, detailedReason),
    detailedReason,
    'a detailed track-specific Agentic explanation is preserved',
  );
  assert.equal(
    verifiedAgenticReason(djTasteReason, true, { artist: 'Magazine', title: 'Burst' }),
    djTasteReason,
    'a verified Agentic replacement preserves the natural DJ reference',
  );
  assert.match(attributedReason, /Mara Vex chose/);
  assert.match(attributedReason, /Carrie Marshall’s taste for post-punk/);
  assert.doesNotMatch(verifiedAgenticReason(attributedReason, false, { artist: 'Magazine', title: 'Burst' }), /Carrie Marshall|taste/i,
    'unverified or guard-overridden reasons cannot retain host or guest preference attribution');
  assert.doesNotMatch(
    verifiedAgenticReason(djTasteReason, false, { artist: 'Magazine', title: 'Burst' }),
    /Mara Vex|taste/i,
    'a kept or guard-overridden Agentic choice strips the DJ preference reference',
  );
});

test('Leanings provenance needs the reviewed replacement to survive enqueue', () => {
  assert.equal(resolveAgenticLeaningsUsage(changedAndQueued), true);
  assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, replacementId: null }), false, 'keeping the preliminary pick is not influence');
  assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, finalId: 'guard-repick' }), false, 'a guard-overridden replacement is not influence');
  assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, queued: false }), false, 'a queue collision is not influence');
  assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, hasLeanings: false }), false, 'no Leanings context means no influence');
  assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, replacementId: 'preliminary', finalId: 'preliminary' }), false, 'an unchanged id is not influence');
});

const agentSource = readFileSync(new URL('../src/broadcast/dj-agent.ts', import.meta.url), 'utf8');
const schemaSource = readFileSync(new URL('../src/broadcast/dj-agent/schemas.ts', import.meta.url), 'utf8');
const basisSchemaStart = schemaSource.indexOf('leaningsBasis: z.string');
const basisSchemaEnd = schemaSource.indexOf("musicalReason: z.string()", basisSchemaStart);
const basisSchemaSource = schemaSource.slice(basisSchemaStart, basisSchemaEnd);
assert.match(basisSchemaSource, /copy exactly one supplied leaningsOptions phrase/i);
assert.doesNotMatch(basisSchemaSource, /warm voices|records that reveal themselves gradually/i,
  'profile phrases are supplied dynamically rather than seeded examples');
const pickStart = agentSource.indexOf('async function pickViaSelectionRoute');
const pickEnd = agentSource.indexOf('\nfunction speechClockContext', pickStart);
assert.ok(pickStart >= 0 && pickEnd > pickStart, 'the selection route must be sliced to its own end');
const pickSource = agentSource.slice(pickStart, pickEnd);
for (const [route, preliminary, resolution] of [
  ['Agentic', 'agentPreliminaryId = String(song.id)', 'agentPickResolution'],
  ['Shortlist', 'shortlistPreliminaryId = String(song.id)', 'shortlistPickResolution'],
]) {
  test(`${route} reviews a blind baseline before guards and settles provenance after enqueue`, () => {
    const preliminaryAt = pickSource.indexOf(preliminary);
    const reviewAt = pickSource.indexOf('await runLeaningsReview(');
    const guardsAt = pickSource.indexOf('await runArtistGuard');
    const enqueueAt = pickSource.indexOf('const queued = await enqueuePick');
    const resolutionAt = pickSource.indexOf(`${resolution}.usedMusicalLeanings = resolveAgenticLeaningsUsage`);
    for (const [name, at] of Object.entries({ preliminaryAt, reviewAt, guardsAt, enqueueAt, resolutionAt })) {
      assert.ok(at >= 0, `${name} marker must exist`);
    }
    assert.ok(preliminaryAt < reviewAt, 'the preliminary pick precedes review');
    assert.ok(reviewAt < guardsAt, 'reviewed choices still pass station guards');
    assert.ok(enqueueAt < resolutionAt, 'provenance waits for enqueue');
  });
}

test('route wiring keeps telemetry and rationale verification specific to each picker', () => {
  assert.match(pickSource, /kind: 'djAgentLeaningsReview'/,
    'the separate review has a purpose-specific telemetry name');
  assert.match(pickSource, /verifiedAgenticReason\(agenticSelectionReason\(replacement, leaningsReason\), true, replacement\)/,
    'an Agentic replacement is worded by the Agentic verifier');
  const finalReasonAt = pickSource.indexOf('// The Shortlist model\'s note');
  const agentReasonAt = pickSource.indexOf('} else if (agentPickResolution)', finalReasonAt);
  const finalReasonEnd = pickSource.indexOf('\n  if (useShortlist) {', agentReasonAt);
  const shortlistReasonBlock = pickSource.slice(finalReasonAt, agentReasonAt);
  const agentReasonBlock = pickSource.slice(agentReasonAt, finalReasonEnd);
  assert.match(shortlistReasonBlock, /shortlistClauseSelectionReason\(song, object\.musicalReason\)/,
    'Shortlist final reasons are rebuilt from a model-written musical clause and verified identity');
  assert.doesNotMatch(shortlistReasonBlock, /agenticSelectionReason/);
  assert.match(agentReasonBlock, /verifiedAgenticReason\(agenticSelectionReason\(song, object\.reason\)/,
    'Agentic final reasons use the Agentic verifier and fallback wording');
  assert.doesNotMatch(agentReasonBlock, /shortlistSelectionReason/);
});

const debugSource = readFileSync(new URL('../../web/components/admin/debug/LlmCalls.tsx', import.meta.url), 'utf8');

test('Shortlist shares its resolution, context and Leanings-blind corrections', () => {
  assert.match(pickSource, /episodeSource \? \{ kind: 'kept' \} : await runArtistGuard/,
    'episode-source tracks skip artist repeat rescue while other paths retain the guard');
  assert.match(pickSource, /telemetry: \{ shortlistResolution: shortlistPickResolution \}/,
    'initial, review and corrective calls share the controller resolution object');
  assert.match(pickSource, /library\.bpmKeyFor\(pickAnchor\)/,
    'Shortlist resolves the predecessor audio facts used to judge transition effects');
  assert.match(pickSource, /selectionContextForPick\(queue, ctx/, 'the shared selection context reaches both routes');
  const start = agentSource.indexOf('export function selectionContextForPick');
  const end = agentSource.indexOf('\nexport function shouldExplore', start);
  assert.ok(start >= 0 && end > start, 'the shared context slice must exist');
  assert.match(agentSource.slice(start, end), /queue\.recentTransitionChoices\(\)/,
    'Shortlist and its Leanings review receive the recent transition ledger');
  assert.match(agentSource, /pickSystem\(showAt, playlistResolved, true, \{ host: null, guest: null, promptValue: null \}\)/,
    'Shortlist corrective choices remain Leanings-blind');
  assert.doesNotMatch(debugSource, /JSON\.parse\(call\.response/,
    'Debug never revives a model self-report from the raw response');
});

test('Agentic presentation never attaches one track\'s note to another track', () => {
  const selected = { id: 'sam', title: 'How Do You Sleep?', artist: 'Sam Smith' };
  assert.equal(
    agenticSelectionReason(selected, 'Porcupine Tree — Of the New Day keeps the atmosphere moving.'),
    '“How Do You Sleep?” by Sam Smith offers a strong musical fit with the current flow.',
  );
  assert.equal(
    agenticSelectionReason(selected, 'Sam Smith — How Do You Sleep? keeps the atmosphere moving.'),
    'Sam Smith — How Do You Sleep? keeps the atmosphere moving.',
  );
  assert.equal(
    agenticSelectionReason(
      { id: 'gabriel', title: 'Digging in the Dirt', artist: 'Peter Gabriel' },
      'Peter Gabriel fits well with the current flow, and',
    ),
    '“Digging in the Dirt” by Peter Gabriel — fits well with the current flow.',
  );
  assert.equal(
    agenticSelectionReason(
      { id: 'qualls', title: 'Black Qualls', artist: 'Thundercat feat. Steve Lacy, Steve Arrington & Childish Gambino' },
      "Thundercat featuring Steve Lacy, Steve Arrington & Childish Gambino with Black Qualls fits the current low-energy vibe.",
    ),
    "Thundercat featuring Steve Lacy, Steve Arrington & Childish Gambino with Black Qualls fits the current low-energy vibe.",
  );
});

test('an Agentic note that names the core of a credited title is kept', () => {
  const khaled = { id: 'khaled', title: 'Final Warning (feat. Bun B, Shawty Lo, Bloodraw, Ace Hood, Brisco, Bali, Lil Scrappy, R. City)', artist: 'DJ Khaled' };
  const named = 'DJ Khaled — Final Warning keeps the posse-cut energy rolling out of the last record.';
  assert.equal(agenticSelectionReason(khaled, named), named, 'a bracketed feature list need not be repeated');
  const bohemia = { id: 'bohemia', title: 'Bumpin My Song Feat. J.Hind', artist: 'Bohemia' };
  const bumpin = '“Bumpin My Song” by Bohemia carries the Punjabi rap thread forward.';
  assert.equal(agenticSelectionReason(bohemia, bumpin), bumpin, 'an inline Feat. credit need not be repeated');
  const kendrick = { id: 'alien', title: 'Alien Girl (Today W/ Her)', artist: 'Kendrick Lamar' };
  const alien = 'Kendrick Lamar’s Alien Girl slows the tempo into something dreamier.';
  assert.equal(agenticSelectionReason(kendrick, alien), alien, 'an edition tag in brackets need not be repeated');
  const remaster = { id: 'rm', title: 'Heroes - 2017 Remaster', artist: 'David Bowie' };
  const heroes = 'David Bowie — Heroes lifts the room with its slow-building wall of sound.';
  assert.equal(agenticSelectionReason(remaster, heroes), heroes, 'a dashed edition suffix need not be repeated');
  const featArtist = { id: 'fa', title: 'Tadow', artist: 'Masego feat. FKJ' };
  const tadow = 'Masego — Tadow keeps the late-night sax glow going.';
  assert.equal(agenticSelectionReason(featArtist, tadow), tadow, 'an artist credit\'s feature need not be repeated');
});

test('the core-title match still refuses a note about another track', () => {
  const khaled = { id: 'khaled', title: 'Final Warning (feat. Bun B)', artist: 'DJ Khaled' };
  assert.equal(
    agenticSelectionReason(khaled, 'DJ Khaled — All I Do Is Win keeps the posse-cut energy rolling.'),
    '“Final Warning (feat. Bun B)” by DJ Khaled offers a strong musical fit with the current flow.',
    'naming the artist alone with another title is still plain copy',
  );
  const up = { id: 'up', title: 'Up (Radio Edit)', artist: 'Shania Twain' };
  assert.equal(
    agenticSelectionReason(up, 'Shania Twain — an upbeat country-pop lift for the hour.'),
    plainAgenticSelectionReason(up),
    'a short one-word core is not matched inside another word, or on its own',
  );
  assert.equal(
    agenticSelectionReason(
      { id: 'sam', title: 'How Do You Sleep? (Acoustic)', artist: 'Sam Smith' },
      'Porcupine Tree — Of the New Day keeps the atmosphere moving.',
    ),
    '“How Do You Sleep? (Acoustic)” by Sam Smith offers a strong musical fit with the current flow.',
  );
});

test('a discarded Agentic note is recorded with what the model wrote', () => {
  assert.match(pickSource, /object\.reason === plainAgenticSelectionReason\(song\)\) \{\n\s+logEvent\('pick\.notePlain', \{ agent: 'pick', to: song\.id \?\? null, note: note\.slice\(0, 400\) \}\);/,
    'the first answer\'s note is logged when it becomes plain copy');
});

// The notes below are the model's own words from a live station's
// pick.notePlain events: accurate notes the capitalised-name read discarded.
test('an Agentic note naming known names keeps its reasoning', () => {
  const refs = ['Bejeweled (Mixed)', 'Taylor Swift', 'Sunday Slow Cooker', 'Punjabi', 'Indian Folk', 'Indian Pop', 'Soul', 'Regional Indian'];
  const kept = (track: any, note: string) => {
    const out = agenticDiscoverySelectionReason(track, note, refs);
    assert.ok(out.endsWith(/[.!?]$/.test(note) ? note : `${note}.`), `${note} → ${out}`);
    assert.doesNotMatch(out, /strong musical fit/);
  };
  kept({ title: 'Chunni (From "Lahoriye" Soundtrack)', artist: 'Amrinder Gill & Jatinder Shah', genre: 'Punjabi' },
    'Warm, rarely aired Amrinder Gill softens the set after two punchy tracks');
  kept({ title: 'Home Care', artist: 'MXRCI & Kahlon', genre: 'Regional Indian' },
    'Rarely aired calm Regional Indian track, eases down after the bright pop burst');
  kept({ title: 'Laayi Rakhin Sohneya', artist: 'Avkash Mann, Noor Chahal, Happy Raikoti & Bilal Wajid', genre: 'Punjabi' },
    'unaired film song, softer warmth after the Taylor Swift and club-leaning detour');
  kept({ title: 'Jhelum Naina', artist: 'Babul Supriyo & Jeet Gannguli', album: 'Very Best of Coke Studio Vol. 1', genre: 'Indian Pop' },
    'Matching 89.1 bpm, Coke Studio soulful texture, rarely heard artist');
  kept({ title: 'Athru Te Akhan', artist: 'Hustinder, Punam Gill, Manwinder Mann & Savraj', genre: 'Punjabi' },
    'Fresh Punjabi artists, low-energy reflective romance, long and unhurried for the slow cooker.');
  kept({ title: 'Mera Pind', artist: 'Gagan Kokri, Bohemia, MXRCI & Rym Gill', genres: ['Punjabi'] },
    'Fresh Punjabi voices, low energy, gentle tempo drop from a frantic-feeling predecessor');
});

test('a capitalised name nothing accounts for still becomes plain copy', () => {
  const refs = ['Sunday Slow Cooker', 'Punjabi', 'Regional Indian'];
  const track = { title: 'Pyaar', artist: 'SIDAK', genre: 'Punjabi' };
  const plain = plainAgenticSelectionReason(track);
  assert.equal(agenticDiscoverySelectionReason(track, 'Elliott Smith’s Rose Parade is calm and reflective, with a close key.', refs), plain,
    'a recalled track the model never searched is not attached to the pick');
  assert.equal(agenticDiscoverySelectionReason(track, 'Massive Attack keeps the late-night hush going after the last record.', refs), plain,
    'a sentence-opening act is not excused by its capital');
  assert.equal(agenticDiscoverySelectionReason(track, 'Warm Regional Indian lift, closer to Diljit Dosanjh than the last pick.', refs), plain,
    'a known genre does not excuse an unknown act in the same note');
  assert.equal(agenticDiscoverySelectionReason(track, 'Fresh Punjabi warmth with a softer “Teardrop” hush to it.', refs), plain,
    'a quoted title is still a claim');
});

test('the Agentic route hands the capitalised-name read its context names', () => {
  assert.match(pickSource, /agenticDiscoverySelectionReason\(song, note, pickNoteReferences\(queue, pickAnchor, activeShow\)\)/);
});
