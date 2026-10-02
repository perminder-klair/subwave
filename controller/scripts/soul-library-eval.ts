// Read-only, library-backed Soul evaluation. Unlike leanings-eval.ts this
// uses the operator's real Navidrome catalogue and production discovery tools,
// but it keeps an entirely disposable STATE_DIR and never imports queue code.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';

const evaluationStateDir = mkdtempSync(join(tmpdir(), 'subwave-soul-library-eval-'));
process.env.STATE_DIR = evaluationStateDir;

const BOB_CONTROL_SOUL = 'Bob is a warm, knowledgeable and enthusiastic radio DJ who loves sharing discoveries with listeners and explaining what makes a great record special.';
const BOB_TREATMENT_SOUL = 'Bob is a lifelong music obsessive with an encyclopaedic knowledge of rock, indie and alternative music. Growing up on the great guitar bands of the 70s, 80s and 90s, he particularly loves classic rock, alternative rock, indie, Britpop, post-punk and progressive rock. His favourites include Pink Floyd, Led Zeppelin, Dire Straits, R.E.M., The Cure, The Smiths, Radiohead, Oasis, Blur and The Stone Roses. Bob loves melodic guitar music, prominent basslines, acoustic guitars, interesting production and songs with strong musicianship. He prefers deeper album tracks and overlooked gems rather than obvious hits, and enjoys discovering newer artists influenced by the music he grew up with. He dislikes manufactured pop, repetitive dance music and novelty records, and avoids overly commercial chart music. Warm, knowledgeable and enthusiastic, Bob loves sharing his musical discoveries with listeners and explaining what makes a great record special.';

const SEEDS = [
  { name: 'killing-moon', title: 'The Killing Moon', artist: 'Echo & the Bunnymen', expectation: 'close-call' },
  { name: 'yellow', title: 'Yellow', artist: 'Coldplay', expectation: 'flow-control' },
];

function argsOf(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--([a-z-]+)$/);
    if (match) args[match[1]] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error('Usage: npm run soul-library-eval -- --models provider:model --station-state /path/to/state [--base-url http://host:port] [--env-file secrets.env] [--iterations 6] [--candidate-cap 8] [--out report.json]');
  process.exit(2);
}

function modelSpecs(raw: string) {
  return raw.split(',').map((label) => {
    const at = label.trim().indexOf(':');
    if (at < 1) fail(`bad model spec: ${label}`);
    return { label: label.trim(), provider: label.trim().slice(0, at), model: label.trim().slice(at + 1) };
  });
}

function configureReadOnlyNavidrome(stateDir: string) {
  const path = join(stateDir, 'setup-config.json');
  if (!existsSync(path)) fail(`missing ${path}`);
  let config: any;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { fail(`cannot read ${path}`); }
  const navidrome = config?.navidrome;
  if (!navidrome?.url || !navidrome?.user || !navidrome?.pass) fail('station setup config has no complete Navidrome credentials');
  process.env.NAVIDROME_URL = navidrome.url;
  process.env.NAVIDROME_USER = navidrome.user;
  process.env.NAVIDROME_PASS = navidrome.pass;
}

function readOpenAiKey(path: string) {
  if (!existsSync(path)) fail(`missing ${path}`);
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/);
    if (match) return match[1].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

type EvalArm = 'control-a' | 'control-b' | 'soul-a' | 'soul-b';

function isSoulArm(arm: EvalArm) {
  return arm.startsWith('soul-');
}

function armOrder(iteration: number): EvalArm[] {
  // Counterbalance call order: a local server's short-term sampling behaviour
  // must not be mistaken for an effect of the persona text.
  const orders: EvalArm[][] = [
    ['control-a', 'soul-a', 'control-b', 'soul-b'],
    ['soul-b', 'control-b', 'soul-a', 'control-a'],
    ['control-b', 'soul-b', 'control-a', 'soul-a'],
    ['soul-a', 'control-a', 'soul-b', 'control-b'],
  ];
  return orders[(iteration - 1) % orders.length];
}

function setBob(cfg: any, arm: EvalArm) {
  cfg.personas = [{ id: 'eval-bob', name: 'Bob', soul: isSoulArm(arm) ? BOB_TREATMENT_SOUL : BOB_CONTROL_SOUL, language: 'English', djMode: false }];
  cfg.activePersonaId = 'eval-bob';
  cfg.shows = [];
  cfg.schedule = [];
  cfg.scheduleOverride = null;
}

// Candidate discovery is real Navidrome data, captured once per pair. These
// frozen tool responses make the final editorial comparison causal: the two
// arms cannot differ because one happened to discover a different library set.
function frozenRealTools(candidates: any[]) {
  const seen = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const reveal = () => candidates;
  return {
    seen,
    tools: {
      similarSongs: tool({ description: 'Real-library candidate snapshot related to the current track. Compare all candidates before choosing.', inputSchema: z.object({ songId: z.string() }), execute: async () => reveal() }),
      tracksByMood: tool({ description: 'The same real-library candidate snapshot, retained for an offline paired comparison.', inputSchema: z.object({ mood: z.string() }), execute: async () => reveal() }),
      randomSongs: tool({ description: 'The same real-library candidate snapshot, retained for an offline paired comparison.', inputSchema: z.object({}), execute: async () => reveal() }),
    },
  };
}

function rotate<T>(items: T[], iteration: number) {
  const offset = (iteration - 1) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (!args.models) fail('--models is required');
  if (!args['station-state']) fail('--station-state is required');
  configureReadOnlyNavidrome(resolve(args['station-state']));
  if (args['env-file']) {
    const key = readOpenAiKey(resolve(args['env-file']));
    if (key) process.env.OPENAI_API_KEY = key;
  }
  const iterations = Math.max(1, Number.parseInt(args.iterations || '6', 10) || 6);
  const candidateCap = Math.max(3, Math.min(20, Number.parseInt(args['candidate-cap'] || '8', 10) || 8));
  const baseUrl = args['base-url']?.trim();
  const models = modelSpecs(args.models);
  const out = resolve(args.out || join('scripts', 'leanings-eval', 'reports', `soul-library-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

  // All controller imports are intentionally late: config.ts must see the
  // temporary state and the read-only Navidrome environment above.
  const settings = await import('../src/settings.js');
  const { djAgent } = await import('../src/llm/sdk.js');
  const { pickSchema, pickSystem } = await import('../src/broadcast/dj-agent/schemas.js');
  const subsonic = await import('../src/music/subsonic.js');
  await settings.load();
  const cfg: any = settings.get();
  cfg.llm.fallback = { ...(cfg.llm.fallback || {}), enabled: false };

  const resolvedSeeds: any[] = [];
  for (const seed of SEEDS) {
    const matches = await subsonic.search(seed.title, { songCount: 25 });
    const track = matches.find((song: any) => song.title?.toLowerCase() === seed.title.toLowerCase() && song.artist?.toLowerCase() === seed.artist.toLowerCase());
    if (!track?.id) fail(`could not resolve ${seed.artist} — ${seed.title} in Navidrome`);
    resolvedSeeds.push({ ...seed, id: track.id });
  }

  const records: any[] = [];
  console.log(`Soul library evaluation: ${models.length} model(s) × ${resolvedSeeds.length} seeds × ${iterations} repetitions × 4 arms (A/A null calibration plus A/B effect)`);
  console.log(`Isolated STATE_DIR: ${evaluationStateDir}`);
  for (const target of models) {
    cfg.llm.provider = target.provider;
    cfg.llm.model = target.model;
    cfg.llm.reasoning = false;
    // A library-backed run starts from disposable settings, so an explicit
    // endpoint is needed for an OpenAI-compatible local server.
    if (baseUrl) cfg.llm.baseUrl = baseUrl;
    if (target.provider === 'openai') {
      if (!process.env.OPENAI_API_KEY) fail('OPENAI_API_KEY is required for OpenAI');
      cfg.llm.apiKey = process.env.OPENAI_API_KEY;
    }
    for (const seed of resolvedSeeds) for (let iteration = 1; iteration <= iterations; iteration++) {
      const discovered = await subsonic.getSimilarSongs(seed.id, { count: 20 });
      if (discovered.length < 3) fail(`${seed.artist} — ${seed.title} yielded fewer than three real similar-song candidates`);
      // Eight is enough for a meaningful editorial choice while keeping the
      // full Bob Soul inside the 12k context of the local 8B llama.cpp model.
      const snapshot = rotate(discovered, iteration).slice(0, candidateCap);
      for (const arm of armOrder(iteration)) {
      setBob(cfg, arm);
      const { tools, seen } = frozenRealTools(snapshot);
      const record: any = { model: target.label, seed: seed.name, seedTrack: { id: seed.id, title: seed.title, artist: seed.artist }, expectation: seed.expectation, arm, iteration, candidateSnapshot: snapshot.map((song: any) => ({ id: song.id, title: song.title, artist: song.artist })), outcome: 'ok' };
      const started = Date.now();
      try {
        const result = await djAgent({
          system: pickSystem(null, true, false, null),
          messages: [{ role: 'user', content: `Now playing "${seed.title}" by ${seed.artist} [id: ${seed.id}]. Pick the next track from the real library. This is an offline evaluation: make no listener-facing link and select only a discovered candidate. The current track is a discovery seed, never a valid pick.` }],
          tools, schema: pickSchema(), maxSteps: 2, providerDiscoveryBudget: true, kind: 'soulLibraryEvalPick',
          validate: (object: any) => !!(object?.id && seen.has(object.id)),
        });
        const selected = seen.get((result.object as any)?.id);
        record.selected = selected ? { id: selected.id, title: selected.title, artist: selected.artist, genre: selected.genre, moods: selected.moods, energy: selected.energy } : null;
        record.reason = (result.object as any)?.reason ?? null;
        record.toolCalls = result.toolCalls?.length ?? 0;
        record.steps = result.steps;
        // Separate Leanings are intentionally absent from this experiment.
        record.usedMusicalLeanings = false;
        record.leaningsTieBreak = null;
        if (!selected) record.outcome = 'violation';
      } catch (error: any) { record.outcome = 'thrown'; record.error = String(error?.message || error); }
      record.ms = Date.now() - started;
      records.push(record);
      console.log(`  ${seed.name}/${arm} #${iteration}: ${record.outcome} (${(record.ms / 1000).toFixed(1)}s)`);
    }
    }
  }
  const select = (model: string, seed: string, iteration: number, arm: EvalArm) => records.find((record) => record.model === model && record.seed === seed && record.iteration === iteration && record.arm === arm)?.selected ?? null;
  const changed = (left: any, right: any) => !!left?.id && !!right?.id && left.id !== right.id;
  const comparisons = models.flatMap((model) => resolvedSeeds.flatMap((seed) => Array.from({ length: iterations }, (_, i) => {
    const iteration = i + 1;
    const controlA = select(model.label, seed.name, iteration, 'control-a');
    const controlB = select(model.label, seed.name, iteration, 'control-b');
    const soulA = select(model.label, seed.name, iteration, 'soul-a');
    const soulB = select(model.label, seed.name, iteration, 'soul-b');
    return { model: model.label, seed: seed.name, iteration, controlA, controlB, soulA, soulB,
      nullPairs: [{ arms: ['control-a', 'control-b'], left: controlA, right: controlB, choiceChanged: changed(controlA, controlB) }, { arms: ['soul-a', 'soul-b'], left: soulA, right: soulB, choiceChanged: changed(soulA, soulB) }],
      effectPairs: [{ arms: ['control-a', 'soul-a'], left: controlA, right: soulA, choiceChanged: changed(controlA, soulA) }, { arms: ['control-b', 'soul-b'], left: controlB, right: soulB, choiceChanged: changed(controlB, soulB) }],
    };
  })));
  const nullPairs = comparisons.flatMap((comparison) => comparison.nullPairs);
  const effectPairs = comparisons.flatMap((comparison) => comparison.effectPairs);
  const complete = (pairs: any[]) => pairs.filter((pair) => pair.left?.id && pair.right?.id);
  const completeNullPairs = complete(nullPairs);
  const completeEffectPairs = complete(effectPairs);
  const nullChanges = completeNullPairs.filter((pair) => pair.choiceChanged).length;
  const effectChanges = completeEffectPairs.filter((pair) => pair.choiceChanged).length;
  const report = { meta: { startedAt: new Date().toISOString(), stateIsolation: true, libraryAccess: 'read-only Navidrome similar-song discovery', candidateProtocol: 'one real-library snapshot per seed/iteration, identical order in all four arms; counterbalanced arm order', measurement: 'A/A null calibration against A/B Soul effect; an effect is meaningful only when it exceeds null sampling variation', stationStateWritten: false, models: models.map((m) => m.label), baseUrl: baseUrl || null, iterations, candidateCap, seeds: resolvedSeeds.map(({ name, id, title, artist, expectation }) => ({ name, id, title, artist, expectation })), personaArms: { control: BOB_CONTROL_SOUL, soul: BOB_TREATMENT_SOUL } }, summary: { completed: `${records.filter((r) => r.outcome === 'ok').length}/${records.length}`, nullChoiceChanges: `${nullChanges}/${completeNullPairs.length}`, soulChoiceChanges: `${effectChanges}/${completeEffectPairs.length}`, excessSoulChoiceChanges: `${effectChanges}/${completeEffectPairs.length} versus null ${nullChanges}/${completeNullPairs.length}`, failures: records.filter((r) => r.outcome !== 'ok').length }, records, comparisons };
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Report: ${out}`);
}

await main();
