// Offline paired evaluation for Musical Leanings.
//
// This deliberately runs outside the broadcast pipeline. It uses a fresh
// STATE_DIR, frozen discovery-tool results, and the production Agentic schema
// and tool-loop. It never touches the queue, session, library, scrobbling, or
// the station's persistent telemetry.
//
// Usage (from controller/):
//   npm run leanings-eval -- --models openai:gpt-5.4-mini --iterations 8
//   npm run leanings-eval -- --models openai:gpt-5.4-mini,ollama:qwen3:8b --iterations 5
//
// The target model's normal credentials must be available in the environment
// (for example OPENAI_API_KEY). Reports default to
// scripts/leanings-eval/reports/, which is intentionally separate from state.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';

// This must happen before any controller import: config.ts captures STATE_DIR
// at module evaluation time, and the LLM telemetry writer uses that config.
// The evaluator may leave disposable telemetry in this temporary directory,
// but cannot append to the live station's events or token budget.
const evaluationStateDir = mkdtempSync(join(tmpdir(), 'subwave-leanings-eval-'));
process.env.STATE_DIR = evaluationStateDir;

type Candidate = {
  id: string;
  title: string;
  artist: string;
  album: string;
  year: number;
  genre: string;
  moods: string[];
  energy: string;
  /** Explicit fixture evidence, available to the model through discovery. */
  editorialFit: string;
};

type Scenario = {
  name: string;
  current: { title: string; artist: string };
  hostLeanings: string;
  /** A badge would be a false positive in this scenario. */
  expectNoLeanings?: boolean;
  candidates: Candidate[];
};

type SoulScenario = {
  name: string;
  current: { title: string; artist: string };
  /** The treatment direction, measured from choices rather than model prose. */
  preferredCandidateIds: string[];
  /** A flow-only fixture must retain this one eligible choice in both arms. */
  soleFlowCandidateId?: string;
  candidates: Candidate[];
};

type EditorialLeaningsContext = {
  host: string | null;
  guest: null;
  promptValue: string | null;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'electronic-close-call',
    current: { title: 'Breathe', artist: 'The Prodigy' },
    hostLeanings: 'Favour electronic music, especially synth-pop, leftfield production, unusual textures and deeper discoveries.',
    candidates: [
      // The ordinary flow case has a slight preference for Breakline's direct
      // breakbeat continuation. Circuit Bloom remains fully eligible, but its
      // unusual synth texture is the intended Leanings tie-breaker.
      { id: 'eval-electronic-1', title: 'Circuit Bloom', artist: 'Signal Glass', album: 'Night Lines', year: 2019, genre: 'synth-pop', moods: ['night', 'driving'], energy: 'high', editorialFit: 'equally high-energy synth-pop with unusual electronic textures and distinctive production' },
      { id: 'eval-electronic-2', title: 'Breakline', artist: 'Pressure Unit', album: 'Headlights', year: 2020, genre: 'electronic', moods: ['night', 'driving'], energy: 'high', editorialFit: 'the closest same-pace breakbeat continuation with raw club energy' },
      { id: 'eval-electronic-3', title: 'Soft Landing', artist: 'Halogen', album: 'Afterimage', year: 2018, genre: 'electronic', moods: ['night'], energy: 'medium', editorialFit: 'warm pads but a clearly gentler energy drop' },
    ],
  },
  {
    name: 'warm-melody-close-call',
    current: { title: 'The Bitterest Pill', artist: 'The Jam' },
    hostLeanings: 'Favour warm voices, strong melodies, melodic post-punk and indie discoveries.',
    candidates: [
      // Grey Parade carries the more direct guitar-and-pace handoff; Gold
      // Thread is still close enough to win only when warmth and melody really
      // break that otherwise even choice.
      { id: 'eval-melody-1', title: 'Gold Thread', artist: 'The Lanterns', album: 'Small Hours', year: 2021, genre: 'post-punk', moods: ['reflective'], energy: 'medium', editorialFit: 'warm lead vocal and a strong melodic post-punk hook, slightly less abrasive but still same energy' },
      { id: 'eval-melody-2', title: 'Grey Parade', artist: 'Static Youth', album: 'Side Streets', year: 2020, genre: 'post-punk', moods: ['reflective'], energy: 'medium', editorialFit: 'the closest same-pace guitar-driven post-punk continuation with a detached vocal' },
      { id: 'eval-melody-3', title: 'Slow Signal', artist: 'Lowlight', album: 'Distant Rooms', year: 2022, genre: 'ambient', moods: ['reflective'], energy: 'low', editorialFit: 'atmospheric but noticeably lower energy' },
    ],
  },
  {
    name: 'obvious-flow-no-tie',
    current: { title: 'Lullaby', artist: 'The Cure' },
    hostLeanings: 'Favour electronic music, unusual textures and deep cuts.',
    expectNoLeanings: true,
    candidates: [
      { id: 'eval-obvious-1', title: 'Night Run', artist: 'Neon Field', album: 'Pulse', year: 2021, genre: 'electronic', moods: ['night'], energy: 'medium', editorialFit: 'an electronic fit, but it makes a sharp energy jump from the current track' },
      { id: 'eval-obvious-2', title: 'After the Rain', artist: 'Quiet Maps', album: 'Stillness', year: 2019, genre: 'dream pop', moods: ['night', 'reflective'], energy: 'low', editorialFit: 'the only candidate matching the current low-energy reflective flow' },
      { id: 'eval-obvious-3', title: 'Crowd Control', artist: 'Street Lamps', album: 'Friday', year: 2020, genre: 'punk', moods: ['energetic'], energy: 'high', editorialFit: 'a high-energy genre and mood clash' },
    ],
  },
];

// Kept outside the candidates returned by frozen tools: this is evaluator
// evidence, not an extra hint that production picks would receive. A claimed
// tie-break must identify a distinctive trait of the chosen fixture candidate,
// not merely reuse broad words such as "energy" or "electronic".
const FIXTURE_LEANINGS_EVIDENCE: Record<string, string[]> = {
  'eval-electronic-1': ['unusual electronic textures', 'distinctive production'],
  'eval-melody-1': ['warm lead vocal', 'strong melodic post-punk hook'],
};

// These are deliberately ordinary operator-facing Souls. The only difference
// between arms is the treatment's musical taste: no musicLean, editorial
// Leanings context, badge reminder, or production prompt is involved.
const BOB_CONTROL_SOUL = 'Bob is a warm, knowledgeable and enthusiastic radio DJ who loves sharing discoveries with listeners and explaining what makes a great record special.';
const BOB_TREATMENT_SOUL = 'Bob is a lifelong music obsessive with an encyclopaedic knowledge of rock, indie and alternative music. Growing up on the great guitar bands of the 70s, 80s and 90s, he particularly loves classic rock, alternative rock, indie, Britpop, post-punk and progressive rock. His favourites include Pink Floyd, Led Zeppelin, Dire Straits, R.E.M., The Cure, The Smiths, Radiohead, Oasis, Blur and The Stone Roses. Bob loves melodic guitar music, prominent basslines, acoustic guitars, interesting production and songs with strong musicianship. He prefers deeper album tracks and overlooked gems rather than obvious hits, and enjoys discovering newer artists influenced by the music he grew up with. He dislikes manufactured pop, repetitive dance music and novelty records, and avoids overly commercial chart music. Warm, knowledgeable and enthusiastic, Bob loves sharing his musical discoveries with listeners and explaining what makes a great record special.';

const SOUL_SCENARIOS: SoulScenario[] = [
  {
    name: 'bob-melodic-guitar-close-call',
    current: { title: 'There She Goes', artist: 'The La\'s' },
    preferredCandidateIds: ['soul-guitar-1'],
    candidates: [
      { id: 'soul-guitar-1', title: 'After the Static', artist: 'Harbour Lights', album: 'Second Avenue', year: 2022, genre: 'indie rock', moods: ['driving', 'reflective'], energy: 'medium', editorialFit: 'a flowing indie handoff with melodic guitars, a prominent bassline and an overlooked-album-track feel' },
      { id: 'soul-guitar-2', title: 'Straight Through', artist: 'The Traffic', album: 'Fast Lane', year: 2021, genre: 'alternative rock', moods: ['driving'], energy: 'medium', editorialFit: 'the most direct same-pace guitar continuation with a tight rhythmic drive' },
      { id: 'soul-guitar-3', title: 'Glass Ceiling', artist: 'Pulse Club', album: 'Weekend', year: 2023, genre: 'dance-pop', moods: ['energetic'], energy: 'high', editorialFit: 'a brighter and more commercial energy jump' },
    ],
  },
  {
    name: 'bob-post-punk-deep-cut-close-call',
    current: { title: 'A Forest', artist: 'The Cure' },
    preferredCandidateIds: ['soul-post-punk-1'],
    candidates: [
      { id: 'soul-post-punk-1', title: 'Maps of the Rain', artist: 'North Arcade', album: 'Quiet Signals', year: 2020, genre: 'post-punk', moods: ['reflective', 'night'], energy: 'medium', editorialFit: 'a warm melodic post-punk deep cut with textured production and an expressive bassline' },
      { id: 'soul-post-punk-2', title: 'Grey Corridor', artist: 'Static Youth', album: 'City Work', year: 2021, genre: 'post-punk', moods: ['reflective', 'night'], energy: 'medium', editorialFit: 'the closest austere same-pace post-punk continuation with a cool detached vocal' },
      { id: 'soul-post-punk-3', title: 'Festival Lights', artist: 'The Headlines', album: 'Singles', year: 2024, genre: 'pop rock', moods: ['energetic'], energy: 'high', editorialFit: 'an obvious chorus-led hit that makes a sizeable energy jump' },
    ],
  },
  {
    name: 'bob-no-tie-flow-control',
    current: { title: 'Wish You Were Here', artist: 'Pink Floyd' },
    preferredCandidateIds: [],
    soleFlowCandidateId: 'soul-no-tie-2',
    candidates: [
      { id: 'soul-no-tie-1', title: 'Bassline City', artist: 'Night Shift', album: 'Neon', year: 2022, genre: 'post-punk', moods: ['driving'], energy: 'high', editorialFit: 'a prominent bassline but a sharp high-energy jump from the acoustic current track' },
      { id: 'soul-no-tie-2', title: 'Open Window', artist: 'Cedar Lane', album: 'Long Way Home', year: 2018, genre: 'folk rock', moods: ['reflective'], energy: 'low', editorialFit: 'the only candidate preserving the acoustic, low-energy reflective flow' },
      { id: 'soul-no-tie-3', title: 'Chart Parade', artist: 'Golden Hour', album: 'Saturday', year: 2024, genre: 'pop', moods: ['energetic'], energy: 'high', editorialFit: 'a manufactured glossy pop production and an abrupt energy clash' },
    ],
  },
];

function orderedCandidates(candidates: Candidate[], iteration: number) {
  const offset = (iteration - 1) % candidates.length;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
}

function setBobPersona(cfg: any, arm: 'control' | 'soul') {
  cfg.personas = [{
    id: 'eval-bob', name: 'Bob', soul: arm === 'soul' ? BOB_TREATMENT_SOUL : BOB_CONTROL_SOUL,
    // Keep all normal personality/presentation settings stable and omit
    // musicLean entirely: this experiment isolates natural Soul prose.
    language: 'English', djMode: false,
  }];
  cfg.activePersonaId = 'eval-bob';
  cfg.shows = [];
  cfg.schedule = [];
  cfg.scheduleOverride = null;
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--([a-z-]+)$/);
    if (match) args[match[1]] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error('Usage: npm run leanings-eval -- --models provider:model[,provider:model...] [--experiment leanings|soul] [--base-url http://host:port] [--iterations N] [--env-file path] [--dry-run] [--out report.json]');
  process.exit(2);
}

function modelSpecs(raw: string) {
  return raw.split(',').map((spec) => {
    const trimmed = spec.trim();
    const separator = trimmed.indexOf(':');
    if (separator < 1 || separator === trimmed.length - 1) usage(`bad model spec "${trimmed}" — expected provider:model`);
    return { label: trimmed, provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) };
  });
}

// Docker env files are data, not shell programs: station descriptions and
// other ordinary values are allowed to contain spaces without shell quoting.
// Read only the credential the direct OpenAI provider needs, and never source
// or evaluate a supplied file.
function readOpenAiKey(envFile: string): string | undefined {
  if (!existsSync(envFile)) usage(`env file does not exist: ${envFile}`);
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    return match[1].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

function frozenTools(candidates: Candidate[]) {
  const seen = new Map<string, Candidate>();
  const reveal = () => {
    for (const candidate of candidates) seen.set(candidate.id, candidate);
    return candidates;
  };
  const tools = {
    tracksTowardJourney: tool({
      description: 'Frozen evaluation candidates that move naturally from the current track. Compare all eligible results before committing.',
      inputSchema: z.object({}),
      execute: async () => reveal(),
    }),
    tracksByMood: tool({
      description: 'Frozen evaluation candidates that fit a requested mood. Compare all eligible results before committing.',
      inputSchema: z.object({ mood: z.string() }),
      execute: async () => reveal(),
    }),
    randomSongs: tool({
      description: 'Frozen evaluation candidates. Use only as a final comparison source.',
      inputSchema: z.object({}),
      execute: async () => reveal(),
    }),
  };
  return { tools, seen };
}

function messagesFor(scenario: Scenario, reminder: string) {
  return [{
    role: 'user' as const,
    content: `Now playing "${scenario.current.title}" by ${scenario.current.artist}. Pick the track to play next. This is an offline evaluation: stay silent, make no listener-facing link, and select only a discovered candidate.${reminder}`,
  }];
}

function safeReason(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function fixtureSupport(candidate: Candidate | undefined, tieBreak: string) {
  if (!candidate || !tieBreak) return false;
  const claimedWords = new Set(tieBreak.toLowerCase().match(/[a-z]{3,}/g) || []);
  return (FIXTURE_LEANINGS_EVIDENCE[candidate.id] || []).some((trait) => {
    const traitWords = trait.toLowerCase().match(/[a-z]{3,}/g) || [];
    // A three-word trait permits a concise two-word paraphrase ("warm vocal");
    // a longer trait needs at least three words, while a two-word trait must
    // be identified completely. This avoids both brittle exact-phrase matching
    // and generic one-word matches.
    const required = traitWords.length <= 3 ? traitWords.length === 2 ? 2 : 2 : 3;
    return traitWords.filter((word) => claimedWords.has(word)).length >= required;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.models) usage('--models is required');
  const experiment = args.experiment || 'leanings';
  if (experiment !== 'leanings' && experiment !== 'soul') usage('--experiment must be "leanings" or "soul"');
  const iterations = Math.max(1, Number.parseInt(args.iterations || '5', 10) || 5);
  const baseUrl = args['base-url']?.trim();
  const models = modelSpecs(args.models);
  const defaultOut = join('scripts', 'leanings-eval', 'reports', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const outPath = resolve(args.out || defaultOut);
  if (args['env-file']) {
    const key = readOpenAiKey(resolve(args['env-file']));
    if (key) process.env.OPENAI_API_KEY = key;
  }

  // Lets an operator inspect exactly what will be exercised, with no provider
  // request and no controller import. It also gives this CLI a cheap safety
  // test that is independent of credentials and network availability.
  if (args['dry-run'] === 'true') {
    const plan = {
      meta: {
        dryRun: true,
        stateIsolation: true,
        experiment,
        models: models.map((model) => model.label),
        baseUrl: baseUrl || null,
        iterations,
        scenarios: experiment === 'soul'
          ? SOUL_SCENARIOS.map(({ name, soleFlowCandidateId }) => ({ name, expected: soleFlowCandidateId ? 'no-tie-flow-control' : 'soul-close-call' }))
          : SCENARIOS.map(({ name, expectNoLeanings }) => ({ name, expected: expectNoLeanings ? 'no-leanings' : 'close-call' })),
      },
      plannedRuns: models.length * (experiment === 'soul' ? SOUL_SCENARIOS.length : SCENARIOS.length) * iterations * 2,
    };
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, JSON.stringify(plan, null, 2));
    console.log(`Dry run: ${plan.plannedRuns} paired-arm calls planned; no provider request made.`);
    console.log(`Plan: ${outPath}`);
    return;
  }

  // Dynamic imports happen only after STATE_DIR has been isolated above.
  const settings = await import('../src/settings.js');
  const { djAgent } = await import('../src/llm/sdk.js');
  const { pickSchema, pickSystem, musicalLeaningsPickReminder, resolvedMusicalLeaningsFlag } = await import('../src/broadcast/dj-agent/schemas.js');

  await settings.load();
  const cfg: any = settings.get();
  cfg.llm.fallback = { ...(cfg.llm.fallback || {}), enabled: false };

  const records: any[] = [];
  const scenarios = experiment === 'soul' ? SOUL_SCENARIOS : SCENARIOS;
  const arms = experiment === 'soul' ? ['control', 'soul'] as const : ['control', 'leanings'] as const;
  console.log(`\n${experiment === 'soul' ? 'Soul' : 'Leanings'} evaluation: ${models.length} model(s) × ${scenarios.length} scenarios × ${iterations} paired runs`);
  console.log(`Isolated STATE_DIR: ${evaluationStateDir}`);

  for (const target of models) {
    cfg.llm.provider = target.provider;
    cfg.llm.model = target.model;
    cfg.llm.reasoning = false;
    // Evaluations begin from disposable settings. An explicit endpoint makes
    // the frozen harness usable with the station's host-reachable local
    // OpenAI-compatible llama.cpp server, without touching live settings.
    if (baseUrl) cfg.llm.baseUrl = baseUrl;
    // The direct OpenAI provider reads apiKey from this in-memory config. Do
    // not write it to settings; a caller can instead provide it in the normal
    // environment used by the controller.
    if (target.provider === 'openai') {
      if (!process.env.OPENAI_API_KEY) usage('OpenAI model requested but OPENAI_API_KEY is unavailable (set it in the environment or pass --env-file)');
      cfg.llm.apiKey = process.env.OPENAI_API_KEY;
    }

    for (const scenario of scenarios) {
      for (let iteration = 1; iteration <= iterations; iteration++) {
        for (const arm of arms) {
          const isSoulExperiment = experiment === 'soul';
          if (isSoulExperiment) setBobPersona(cfg, arm as 'control' | 'soul');
          const leaningsScenario = scenario as Scenario;
          const soulScenario = scenario as SoulScenario;
          const context: EditorialLeaningsContext | null = !isSoulExperiment && arm === 'leanings'
            ? { host: leaningsScenario.hostLeanings, guest: null, promptValue: `Host: ${leaningsScenario.hostLeanings}` }
            : null;
          const reminder = context ? musicalLeaningsPickReminder(context) : '';
          // Rotation is identical for the two arms of each pair, but shifts
          // between iterations so a deterministic first-result preference
          // cannot masquerade as a Soul effect.
          const candidates = isSoulExperiment ? orderedCandidates(soulScenario.candidates, iteration) : leaningsScenario.candidates;
          const { tools, seen } = frozenTools(candidates);
          const started = Date.now();
          const record: any = {
            model: target.label,
            scenario: scenario.name,
            arm,
            iteration,
            expected: isSoulExperiment
              ? (soulScenario.soleFlowCandidateId ? 'no-tie-flow-control' : 'soul-close-call')
              : (leaningsScenario.expectNoLeanings ? 'no-leanings' : 'close-call'),
            outcome: 'ok',
            violations: [] as string[],
          };
          try {
            const result = await djAgent({
              system: pickSystem(null, true, false, context),
              messages: messagesFor(scenario, reminder),
              tools,
              schema: pickSchema(),
              maxSteps: 2,
              providerDiscoveryBudget: true,
              // This label makes accidental use easy to identify even inside
              // the evaluator's disposable telemetry.
              kind: 'leaningsEvalPick',
              validate: (object: any) => !!(object?.id && seen.has(object.id)),
            });
            const object: any = result.object;
            const selected = seen.get(object?.id);
            const reason = safeReason(object?.reason);
            const rawTieBreak = safeReason(object?.leaningsTieBreak);
            // Leanings diagnostics are not evidence in the Soul experiment.
            // Keep the public analysis fields intentionally false/null while
            // retaining raw values for debugging a schema/provider failure.
            const tieBreak = isSoulExperiment ? '' : rawTieBreak;
            const verifiedLeanings = isSoulExperiment ? false : resolvedMusicalLeaningsFlag(context, object?.usedMusicalLeanings, tieBreak);
            record.selected = selected ? { id: selected.id, title: selected.title, artist: selected.artist, editorialFit: selected.editorialFit } : null;
            record.reason = reason;
            record.rawUsedMusicalLeanings = object?.usedMusicalLeanings ?? null;
            record.leaningsTieBreak = tieBreak || null;
            record.verifiedLeanings = verifiedLeanings;
            if (isSoulExperiment) {
              record.usedMusicalLeanings = false;
              record.leaningsTieBreak = null;
              record.rawLeaningsTieBreak = rawTieBreak || null;
              record.soulPreferenceCandidate = soulScenario.preferredCandidateIds.includes(selected?.id || '');
              record.noTieFlowPreserved = !soulScenario.soleFlowCandidateId || selected?.id === soulScenario.soleFlowCandidateId;
            }
            record.fixtureSpecificTieBreak = fixtureSupport(selected, tieBreak);
            record.steps = result.steps;
            record.toolCalls = result.toolCalls?.length ?? 0;
            if (!selected) record.violations.push('hallucinated-id');
            if (arm === 'control' && verifiedLeanings) record.violations.push('leanings-without-context');
            if (!isSoulExperiment && leaningsScenario.expectNoLeanings && verifiedLeanings) record.violations.push('leanings-without-close-call');
            if (verifiedLeanings && !record.fixtureSpecificTieBreak) record.violations.push('unsupported-leanings-evidence');
            if (object?.usedMusicalLeanings === false && tieBreak) record.violations.push('tie-break-without-claim');
            if (record.violations.length) record.outcome = 'violation';
          } catch (error: any) {
            record.outcome = 'thrown';
            record.error = String(error?.message || error);
          }
          record.ms = Date.now() - started;
          records.push(record);
          console.log(`  ${target.label}  ${scenario.name}/${arm} #${iteration}  ${record.outcome}  ${(record.ms / 1000).toFixed(1)}s`);
        }
      }
    }
  }

  const pairs = models.flatMap((target) => scenarios.flatMap((scenario) => Array.from({ length: iterations }, (_, index) => {
    const iteration = index + 1;
    const control = records.find((r) => r.model === target.label && r.scenario === scenario.name && r.iteration === iteration && r.arm === 'control');
    const treatment = records.find((r) => r.model === target.label && r.scenario === scenario.name && r.iteration === iteration && r.arm === (experiment === 'soul' ? 'soul' : 'leanings'));
    const soulScenario = scenario as SoulScenario;
    return {
      model: target.label,
      scenario: scenario.name,
      iteration,
      controlId: control?.selected?.id ?? null,
      treatmentId: treatment?.selected?.id ?? null,
      choiceChanged: !!control?.selected?.id && !!treatment?.selected?.id && control.selected.id !== treatment.selected.id,
      verifiedLeanings: treatment?.verifiedLeanings === true,
      ...(experiment === 'soul' ? {
        treatmentInPreferenceDirection: !!treatment?.selected?.id && soulScenario.preferredCandidateIds.includes(treatment.selected.id) && !soulScenario.preferredCandidateIds.includes(control?.selected?.id || ''),
        treatmentAwayFromPreference: soulScenario.preferredCandidateIds.includes(control?.selected?.id || '') && !soulScenario.preferredCandidateIds.includes(treatment?.selected?.id || ''),
        noTieRegression: !!soulScenario.soleFlowCandidateId && treatment?.selected?.id !== soulScenario.soleFlowCandidateId,
      } : {}),
    };
  })));
  const treatmentArm = experiment === 'soul' ? 'soul' : 'leanings';
  const verified = records.filter((r) => r.arm === 'leanings' && r.verifiedLeanings).length;
  const treatmentRuns = records.filter((r) => r.arm === treatmentArm).length;
  const changed = pairs.filter((p) => p.choiceChanged).length;
  const completePairs = pairs.filter((p) => p.controlId && p.treatmentId).length;
  const counterfactualLeanings = pairs.filter((p) => p.verifiedLeanings && p.choiceChanged).length;
  const unprovenTieBreaks = pairs.filter((p) => p.verifiedLeanings && !p.choiceChanged).length;
  const leaningsRecords = records.filter((record) => record.arm === 'leanings');
  const closeCallLeanings = leaningsRecords.filter((record) => !SCENARIOS.find((scenario) => scenario.name === record.scenario)?.expectNoLeanings);
  const noTieLeanings = leaningsRecords.filter((record) => SCENARIOS.find((scenario) => scenario.name === record.scenario)?.expectNoLeanings);
  const rawControlDeclarations = records.filter((record) => record.arm === 'control' && record.rawUsedMusicalLeanings === true).length;
  const selectedDistribution = Object.fromEntries(scenarios.map((scenario) => [scenario.name, Object.fromEntries(arms.map((arm) => [arm, records
    .filter((record) => record.scenario === scenario.name && record.arm === arm)
    .reduce((counts, record) => {
      const id = record.selected?.id || 'none';
      counts[id] = (counts[id] || 0) + 1;
      return counts;
    }, {} as Record<string, number>)]))]));
  const report = {
    meta: {
      startedAt: new Date().toISOString(),
      stateIsolation: true,
      experiment,
      models: models.map((model) => model.label),
      baseUrl: baseUrl || null,
      iterations,
      ...(experiment === 'soul' ? {
        personaArms: { control: BOB_CONTROL_SOUL, soul: BOB_TREATMENT_SOUL },
        showBrief: null,
        scenarios: SOUL_SCENARIOS.map(({ name, preferredCandidateIds, soleFlowCandidateId }) => ({ name, preferredCandidateIds, soleFlowCandidateId: soleFlowCandidateId || null })),
      } : {
        scenarios: SCENARIOS.map(({ name, expectNoLeanings }) => ({ name, expected: expectNoLeanings ? 'no-leanings' : 'close-call' })),
        fixtureLeaningsEvidence: FIXTURE_LEANINGS_EVIDENCE,
      }),
    },
    summary: experiment === 'soul' ? {
      selectedDistribution,
      changedChoices: `${changed}/${completePairs}`,
      preferenceDirectionChanges: `${pairs.filter((pair) => pair.treatmentInPreferenceDirection).length}/${completePairs}`,
      awayFromPreference: pairs.filter((pair) => pair.treatmentAwayFromPreference).length,
      noTieRegressions: pairs.filter((pair) => pair.noTieRegression).length,
      violations: records.filter((r) => r.outcome === 'violation').length,
      failures: records.filter((r) => r.outcome === 'thrown').length,
    } : {
      verifiedLeanings: `${verified}/${treatmentRuns}`,
      closeCallDeclarations: `${closeCallLeanings.filter((record) => record.verifiedLeanings).length}/${closeCallLeanings.length}`,
      noTieFalsePositives: `${noTieLeanings.filter((record) => record.verifiedLeanings).length}/${noTieLeanings.length}`,
      rawControlDeclarationsRejected: `${rawControlDeclarations}/${records.filter((record) => record.arm === 'control').length}`,
      fixtureSpecificEvidence: `${leaningsRecords.filter((record) => record.verifiedLeanings && record.fixtureSpecificTieBreak).length}/${leaningsRecords.filter((record) => record.verifiedLeanings).length}`,
      changedChoices: `${changed}/${completePairs}`,
      counterfactualLeanings: `${counterfactualLeanings}/${treatmentRuns}`,
      unprovenTieBreaks,
      violations: records.filter((r) => r.outcome === 'violation').length,
      failures: records.filter((r) => r.outcome === 'thrown').length,
    },
    records,
    pairs,
  };
  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  if (experiment === 'soul') {
    console.log(`\nSoul preference-direction changes: ${report.summary.preferenceDirectionChanges}; no-tie regressions: ${report.summary.noTieRegressions}; changed paired choices: ${report.summary.changedChoices}`);
  } else {
    console.log(`\nEvidenced Leanings: ${report.summary.verifiedLeanings}; close-call declarations: ${report.summary.closeCallDeclarations}; no-tie false positives: ${report.summary.noTieFalsePositives}; fixture-specific evidence: ${report.summary.fixtureSpecificEvidence}; raw control declarations rejected: ${report.summary.rawControlDeclarationsRejected}`);
  }
  console.log(`Report: ${outPath}`);
}

await main();
