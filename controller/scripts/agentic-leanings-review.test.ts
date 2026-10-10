import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-agentic-leanings-review-'));

const settings = await import('../src/settings.js');
await settings.load();

const {
  agenticLeaningsReviewPrompt,
  agenticLeaningsReviewSchema,
  agenticLeaningsReviewSystem,
  NO_AGENTIC_LEANINGS_INFLUENCE,
} = await import('../src/broadcast/dj-agent/schemas.js');
const {
  agenticLeaningsPhrases,
  agenticLeaningsSelectionReason,
  compactAgenticReviewCandidate,
  resolveAgenticLeaningsUsage,
  selectAgenticReviewCandidates,
  validateAgenticLeaningsReplacement,
  agenticDiscoverySelectionReason,
  agenticSelectionReason,
  verifiedAgenticReason,
} = await import('../src/broadcast/dj-agent/leanings-review.js');

const leaningsOptions = ['warm voices', 'strong melodies'];
const schema = agenticLeaningsReviewSchema(['alternative', 'preliminary'], leaningsOptions, 'preliminary');
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

const prompt = agenticLeaningsReviewPrompt({
  baseline: { id: 'preliminary', artist: 'First Artist', title: 'First Track' },
  challengers: [{ id: 'alternative', artist: 'Second Artist', title: 'Second Track' }],
  leaningsOptions,
  context: { djName: 'Mara Vex' },
});
assert.match(prompt, /"baseline"/i);
assert.match(prompt, /"challengers"/i);
assert.match(prompt, /Use this decision order/i);
assert.match(prompt, /Do not independently rerank/i);
assert.match(prompt, /leaningsBasis=NO_LEANINGS_INFLUENCE/i);
assert.match(prompt, /flowCloseness="close"/i);
assert.match(prompt, /leaningsMatches/i);
assert.match(prompt, /roughly 12–28 words/i);
assert.match(prompt, /controller adds the verified names and exact evidence/i);
assert.match(prompt, /beginning with "its" or "it"/i);
assert.match(prompt, /Do not mention preferences, Leanings, baseline, challenger, preliminary choice, current flow/i);
assert.doesNotMatch(prompt, /musicalLeanings/i, 'the compact review receives only controller-extracted exact options');
assert.ok(agenticLeaningsReviewSystem().length < 600, 'the review uses a compact dedicated system instruction');
assert.doesNotMatch(agenticLeaningsReviewSystem(), /Four Acres|on-air|station house/i);

assert.deepEqual(agenticLeaningsPhrases({
  host: 'Shelby strongly favours electronic music across synth-pop, electro, house, techno, trip-hop, big beat, IDM and leftfield electronica. She enjoys distinctive production, unusual textures and deeper catalogue discoveries.',
  guest: null,
}), ['electronic music', 'synth-pop', 'electro', 'house', 'techno', 'trip-hop', 'big beat', 'IDM', 'leftfield electronica', 'distinctive production', 'unusual textures', 'deeper catalogue discoveries']);
assert.deepEqual(agenticLeaningsPhrases({ host: 'Warm voices, patient dub and deeper cuts.', guest: null }), ['Warm voices', 'patient dub', 'deeper cuts']);

const baselineCandidate = { id: 'baseline', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 120, key: '8A', instrumental: false };
const candidatePool = [
  { id: 'far', energy: 'high', moods: ['workout'], genre: 'Metal', bpm: 75, key: '2B', instrumental: false },
  { id: 'close-b', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 121, key: '8A', instrumental: false },
  baselineCandidate,
  { id: 'close-a', energy: 'medium', moods: ['reflective'], genre: 'Electronic', bpm: 122, key: '8A', instrumental: false },
];
const reviewedForward = selectAgenticReviewCandidates(baselineCandidate, candidatePool, [], 3).map((candidate) => candidate.id);
const reviewedReverse = selectAgenticReviewCandidates(baselineCandidate, [...candidatePool].reverse(), [], 3).map((candidate) => candidate.id);
assert.deepEqual(reviewedForward, ['baseline', 'close-a', 'close-b']);
assert.deepEqual(reviewedReverse, reviewedForward, 'challenger selection is invariant to discovery insertion order');
const profileMatchPool = [
  ...candidatePool,
  { id: 'profile-match', energy: 'high', moods: ['workout'], genre: 'Synth-Pop', bpm: 90, key: '2B', instrumental: false },
  { id: 'ordinary-third', energy: 'medium', moods: ['reflective'], genre: 'Rock', bpm: 123, key: '8A', instrumental: false },
];
assert.ok(
  selectAgenticReviewCandidates(baselineCandidate, profileMatchPool, ['synth-pop'], 5).some((candidate) => candidate.id === 'profile-match'),
  'the compact review reserves room for an exact metadata-grounded profile match',
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

const replacement = { artist: 'Buddy Holly', title: 'Rave On' };
const musicalLeanings = 'She enjoys warm voices, strong melodies, thoughtful songwriting and records that reveal themselves gradually.';
assert.deepEqual(validateAgenticLeaningsReplacement({
  musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
  leaningsBasis: 'strong melodies',
  musicalLeanings,
  allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
  supportedLeanings: ['strong melodies'],
  flowCloseness: 'close',
}), { valid: true, basis: 'strong melodies' });
assert.deepEqual(validateAgenticLeaningsReplacement({
  musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
  leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE,
  musicalLeanings,
  allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
  supportedLeanings: ['strong melodies'],
  flowCloseness: 'close',
}), { valid: false, reason: 'missing-leanings-basis' }, 'a changed id cannot use the no-influence sentinel');
assert.deepEqual(validateAgenticLeaningsReplacement({
  musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
  leaningsBasis: 'melodic songwriting',
  musicalLeanings,
  allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
  supportedLeanings: ['strong melodies'],
  flowCloseness: 'close',
}), { valid: false, reason: 'missing-leanings-basis' }, 'a phrase outside the controller options cannot masquerade as evidence');
assert.deepEqual(validateAgenticLeaningsReplacement({
  musicalReason: 'too short',
  leaningsBasis: 'strong melodies',
  musicalLeanings,
  allowedLeanings: ['warm voices', 'strong melodies', 'thoughtful songwriting'],
  supportedLeanings: ['strong melodies'],
  flowCloseness: 'close',
}), { valid: false, reason: 'weak-musical-reason' });
assert.deepEqual(validateAgenticLeaningsReplacement({
  musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
  leaningsBasis: 'strong melodies',
  musicalLeanings,
  allowedLeanings: ['warm voices', 'strong melodies'],
  supportedLeanings: [],
  flowCloseness: 'close',
}), { valid: false, reason: 'basis-not-supported-by-candidate' });
assert.deepEqual(validateAgenticLeaningsReplacement({
  musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
  leaningsBasis: 'strong melodies',
  musicalLeanings,
  allowedLeanings: ['warm voices', 'strong melodies'],
  supportedLeanings: ['strong melodies'],
  flowCloseness: 'weak',
}), { valid: false, reason: 'not-flow-tie' });
const generatedLeaningsReason = agenticLeaningsSelectionReason({
  replacement,
  djName: 'Lucy Harper',
  basis: 'strong melodies',
  musicalReason: 'its bright melodic momentum lifts the current flow without an abrupt change',
});
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

const fallbackReason = agenticSelectionReason(
  { artist: 'The Last Dinner Party', title: 'This Is the Killer Speaking' },
  'short scratchpad',
);
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
const mismatchedDiscoveryReason = agenticDiscoverySelectionReason(
  { artist: 'Buddy Holly', title: 'Rave On' },
  'Elliott Smith’s Rose Parade is calm and reflective, with a harmonically close key.',
);
assert.doesNotMatch(mismatchedDiscoveryReason, /Elliott Smith|Rose Parade/i,
  'a reason that appears to name another selection is not attached to the discovery pick');
assert.match(mismatchedDiscoveryReason, /Rave On.*Buddy Holly/i);
const detailedReason = 'The Last Dinner Party — This Is the Killer Speaking: its theatrical vocal and taut guitar arrangement sharpen the current flow without abandoning its melodic thread.';
assert.equal(
  agenticSelectionReason({ artist: 'The Last Dinner Party', title: 'This Is the Killer Speaking' }, detailedReason),
  detailedReason,
  'a detailed track-specific Agentic explanation is preserved',
);
const djTasteReason = 'Magazine — Burst: its wiry post-punk guitars sharpen the transition while matching Mara Vex’s taste for angular, melodic records.';
assert.equal(
  verifiedAgenticReason(djTasteReason, true, { artist: 'Magazine', title: 'Burst' }),
  djTasteReason,
  'a verified replacement preserves the natural DJ reference',
);
assert.doesNotMatch(
  verifiedAgenticReason(djTasteReason, false, { artist: 'Magazine', title: 'Burst' }),
  /Mara Vex|taste/i,
  'a kept or guard-overridden choice strips the DJ preference reference',
);

const changedAndQueued = {
  hasLeanings: true,
  preliminaryId: 'preliminary',
  replacementId: 'alternative',
  finalId: 'alternative',
  queued: true,
};
assert.equal(resolveAgenticLeaningsUsage(changedAndQueued), true);
assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, replacementId: null }), false, 'keeping the preliminary pick is not influence');
assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, finalId: 'guard-repick' }), false, 'a guard-overridden replacement is not influence');
assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, queued: false }), false, 'a queue collision is not influence');
assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, hasLeanings: false }), false, 'no Leanings context means no influence');
assert.equal(resolveAgenticLeaningsUsage({ ...changedAndQueued, replacementId: 'preliminary', finalId: 'preliminary' }), false, 'an unchanged id is not influence');

const agentSource = readFileSync(new URL('../src/broadcast/dj-agent.ts', import.meta.url), 'utf8');
const schemaSource = readFileSync(new URL('../src/broadcast/dj-agent/schemas.ts', import.meta.url), 'utf8');
const basisSchemaStart = schemaSource.indexOf('leaningsBasis: z.string');
const basisSchemaEnd = schemaSource.indexOf("musicalReason: z.string()", basisSchemaStart);
const basisSchemaSource = schemaSource.slice(basisSchemaStart, basisSchemaEnd);
assert.match(basisSchemaSource, /copy exactly one supplied leaningsOptions phrase/i);
assert.doesNotMatch(basisSchemaSource, /warm voices|records that reveal themselves gradually/i,
  'profile phrases are supplied dynamically rather than seeded examples');
const pickStart = agentSource.indexOf('async function pickViaAgent');
const pickEnd = agentSource.indexOf('\nasync function ', pickStart + 1);
const pickSource = agentSource.slice(pickStart, pickEnd);
const preliminaryAt = pickSource.indexOf('const preliminaryId =');
const reviewAt = pickSource.indexOf('schema: agenticLeaningsReviewSchema');
const guardsAt = pickSource.indexOf('await runArtistGuard<any>');
const enqueueAt = pickSource.indexOf('const queued = await enqueuePick');
const resolutionAt = pickSource.indexOf('agentPickResolution.usedMusicalLeanings = resolveAgenticLeaningsUsage');
assert.ok(preliminaryAt >= 0 && preliminaryAt < reviewAt,
  'a valid Leanings-blind preliminary pick must exist before the review');
assert.ok(reviewAt < guardsAt,
  'the review replacement must still pass through the station guards');
assert.ok(enqueueAt < resolutionAt,
  'the controller must not report Leanings influence until enqueue has resolved');
assert.match(pickSource, /kind: 'djAgentLeaningsReview'/,
  'the separate review has a purpose-specific telemetry name');
assert.match(pickSource, /selectAgenticReviewCandidates\(song, \[\.\.\.extras\.seen\.values\(\)\], leaningsOptions\)/,
  'the review receives a small deterministic set around the real Leanings-blind baseline');
assert.match(pickSource.slice(reviewAt - 900, reviewAt + 300), /system: agenticLeaningsReviewSystem\(\)/,
  'the review avoids the full on-air persona system prompt');
assert.match(pickSource, /temperature: 0/,
  'the private counterfactual review uses deterministic sampling where the provider supports it');
assert.match(pickSource, /agenticLeaningsSelectionReason/,
  'the controller builds the displayed reason from verified identity and exact evidence');

assert.match(pickSource, /agenticSelectionReason\(song, object\.reason\)/,
  'Agentic final reasons use the Agentic verifier and fallback wording');
assert.doesNotMatch(pickSource, /shortlistSelectionReason/,
  'the Agentic PR does not depend on the later Track Shortlist implementation');

console.log('agentic leanings review: replacement proof verified');
