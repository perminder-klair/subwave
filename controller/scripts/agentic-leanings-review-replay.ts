// Offline replay for the compact Agentic Leanings review.
//
// The fixture contains no queue/session state and this script performs no
// station-state writes. Telemetry is isolated in disposable state. Each
// iteration rotates discovery insertion order before building the
// deterministic compact set, making candidate-order bias visible alongside the
// model's selected id and exact evidence phrase.

import { readFile } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveActiveStationDir } from '../src/stations/resolve.js';

// config.ts captures state at import time and can migrate station files. Read
// only the active model settings before redirecting all controller imports.
const sourceRoot = process.env.STATE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../state');
const sourceSettings = join(resolveActiveStationDir(sourceRoot), 'settings.json');
const replayStateDir = mkdtempSync(join(tmpdir(), 'subwave-leanings-replay-'));
if (existsSync(sourceSettings)) copyFileSync(sourceSettings, join(replayStateDir, 'settings.json'));
process.env.STATE_DIR = replayStateDir;
const settings = await import('../src/settings.js');
const { djObject } = await import('../src/llm/sdk.js');
const {
  agenticLeaningsReviewPrompt,
  agenticLeaningsReviewSchema,
  agenticLeaningsReviewSystem,
  NO_AGENTIC_LEANINGS_INFLUENCE,
} = await import('../src/broadcast/dj-agent/schemas.js');
const {
  agenticLeaningsSources,
  agenticLeaningsSelectionReason,
  compactAgenticReviewCandidate,
  selectAgenticReviewCandidates,
  validateAgenticLeaningsReplacement,
} = await import('../src/broadcast/dj-agent/leanings-review.js');

type ReplayFixture = {
  name: string;
  djName: string;
  currentTrack?: Record<string, unknown> | null;
  musicalLeanings: string;
  baseline: Record<string, unknown> & { id: string };
  candidates: Array<Record<string, unknown> & { id: string }>;
  expected?: { selectedId?: string; leaningsBasis?: string };
};

async function main() {
  const [fixtureArg = 'scripts/fixtures/agentic-leanings-review/shelby-opportunities.json', iterationsArg = '3'] = process.argv.slice(2);
  const iterations = Number.parseInt(iterationsArg, 10);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) throw new Error('iterations must be between 1 and 20');
  const fixture = JSON.parse(await readFile(resolve(fixtureArg), 'utf8')) as ReplayFixture;
  await settings.load();
  // Host-side development cannot resolve a Docker-only model hostname. This
  // optional override mutates only the process-local settings cache; it never
  // writes station settings. Example: http://127.0.0.1:8087/v1.
  const replayBaseUrl = process.env.LEANINGS_REPLAY_BASE_URL?.trim().replace(/\/+$/, '');
  if (replayBaseUrl) {
    const llm = settings.get().llm;
    llm.baseUrl = replayBaseUrl;
    llm.providerBaseUrls = { ...(llm.providerBaseUrls ?? {}), [llm.provider]: replayBaseUrl };
  }

  const editorialLeanings = { host: fixture.musicalLeanings, guest: null };
  const leaningsSources = agenticLeaningsSources(editorialLeanings, fixture.djName);
  const leaningsOptions = leaningsSources.map(({ phrase }) => phrase);
  const allCandidates = [fixture.baseline, ...fixture.candidates.filter((candidate) => candidate.id !== fixture.baseline.id)];
  let stableCandidateIds: string[] | null = null;
  let expected = 0;

  console.log(`\n=== Compact Agentic Leanings replay: ${fixture.name} × ${iterations} ===`);
  console.log(`Isolated STATE_DIR: ${replayStateDir}`);
  console.log(`Leanings options: ${leaningsOptions.join(' | ')}`);
  for (let run = 0; run < iterations; run += 1) {
    const rotated = [...allCandidates.slice(run % allCandidates.length), ...allCandidates.slice(0, run % allCandidates.length)];
    const reviewCandidates = selectAgenticReviewCandidates(fixture.baseline, rotated, leaningsOptions);
    const candidateIds = reviewCandidates.map((candidate) => String(candidate.id));
    if (stableCandidateIds && JSON.stringify(candidateIds) !== JSON.stringify(stableCandidateIds)) {
      throw new Error(`compact candidate set changed with discovery order: ${candidateIds.join(', ')}`);
    }
    stableCandidateIds = candidateIds;
    const compact = reviewCandidates.map((candidate) => compactAgenticReviewCandidate(candidate, leaningsOptions, fixture.baseline));
    const review = await djObject({
      system: agenticLeaningsReviewSystem(),
      prompt: agenticLeaningsReviewPrompt({
        baseline: compact[0],
        challengers: compact.slice(1),
        leaningsOptions,
        leaningsSources,
        context: { currentTrack: fixture.currentTrack ?? null, djName: fixture.djName },
      }),
      schema: agenticLeaningsReviewSchema(candidateIds, leaningsOptions, fixture.baseline.id),
      temperature: 0,
      kind: 'agenticLeaningsCompactReplay',
    });
    const replacement = review.selectedId === fixture.baseline.id
      ? null
      : reviewCandidates.find((candidate) => candidate.id === review.selectedId) ?? null;
    const validation = replacement ? validateAgenticLeaningsReplacement({
      musicalReason: review.musicalReason,
      leaningsBasis: review.leaningsBasis,
      musicalLeanings: fixture.musicalLeanings,
      allowedLeanings: leaningsOptions,
      supportedLeanings: Array.isArray(compact.find((candidate) => candidate.id === replacement.id)?.leaningsMatches)
        ? compact.find((candidate) => candidate.id === replacement.id)!.leaningsMatches as string[]
        : [],
      flowCloseness: compact.find((candidate) => candidate.id === replacement.id)?.flowCloseness,
    }) : null;
    const resolvedSelectedId = replacement && validation?.valid ? review.selectedId : fixture.baseline.id;
    const resolvedBasis = replacement && validation?.valid ? validation.basis : NO_AGENTIC_LEANINGS_INFLUENCE;
    const expectedBasisMatches = !fixture.expected?.leaningsBasis
      || (fixture.expected.leaningsBasis === NO_AGENTIC_LEANINGS_INFLUENCE
        ? resolvedBasis === NO_AGENTIC_LEANINGS_INFLUENCE
        : resolvedBasis === fixture.expected.leaningsBasis);
    const matches = (!fixture.expected?.selectedId || resolvedSelectedId === fixture.expected.selectedId)
      && expectedBasisMatches;
    if (matches) expected += 1;
    const reason = replacement && validation?.valid
      ? agenticLeaningsSelectionReason({
        replacement,
        djName: fixture.djName,
        basis: validation.basis,
        musicalReason: review.musicalReason,
      })
      : null;
    console.log(`${matches ? 'OK  ' : 'MISS'} run ${run + 1}: proposed=${review.selectedId} basis=${JSON.stringify(review.leaningsBasis)} valid=${validation?.valid ?? false} resolved=${resolvedSelectedId}`);
    console.log(`     musicalReason=${JSON.stringify(review.musicalReason)}`);
    if (reason) console.log(`     ${reason}`);
  }
  console.log(`Stable compact set: ${stableCandidateIds?.join(', ')}`);
  console.log(`Expected decision: ${expected}/${iterations}`);
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
