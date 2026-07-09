// llm-bench — matrix benchmark for SUB/WAVE's on-air LLM calls.
//
// Runs every kind × scenario × iteration against each model, scoring
// reliability + deterministic rule checks (see rules.ts). Live prompts and
// schemas are imported from src/ — the bench never copies them. No live
// station contact: fixtures fake the library, tools, and world data;
// settings.llm is overridden in-memory per model and never persisted.
//
// Usage (host, from a clone — same environment as picker-test.mjs):
//   npm run llm-bench -- --models ollama:qwen3:8b,openrouter:google/gemma-4-31b-it
//   npm run llm-bench -- --models ollama:qwen3:8b --kinds pick,segment --modes pool --iterations 5
//
// Flags:
//   --models      comma list of provider:model (REQUIRED; first colon splits)
//   --kinds       comma list of groups (pick|segment|request|scripts|banter|programme)
//                 or exact kind names; default all
//   --modes       pool,agent (default both). 'any' kinds always run once.
//   --iterations  runs per scenario (default 3)
//   --out         JSON report path (default scripts/llm-bench/reports/<ts>.json)
//
// API keys resolve exactly as live (state/secrets.env / settings / env);
// OLLAMA_URL overrides the persisted ollamaUrl for off-container runs.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as settings from '../../src/settings.js';
import { loadSecretsIntoEnv } from '../../src/setup/secrets.js';
import { isUnreachable } from '../../src/llm/sdk.js';
import { recentCalls } from '../../src/llm/log.js';
import { Reporter, bucketError, type RunRecord } from './report.js';
import type { KindSpec } from './kinds/types.js';
import { specs as pickSpecs } from './kinds/pick.js';
import { specs as segmentSpecs } from './kinds/segment.js';
import { specs as requestSpecs } from './kinds/request.js';
import { specs as scriptSpecs } from './kinds/scripts.js';
import { specs as banterSpecs } from './kinds/banter.js';
import { specs as programmeSpecs } from './kinds/programme.js';

const ALL_SPECS: KindSpec[] = [
  ...pickSpecs, ...segmentSpecs, ...requestSpecs, ...scriptSpecs, ...banterSpecs, ...programmeSpecs,
];

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)$/);
    if (m) args[m[1]] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('Usage: npm run llm-bench -- --models provider:model[,provider:model...] '
    + '[--kinds pick,segment,...] [--modes pool,agent] [--iterations N] [--out file.json]');
  console.error(`Groups: ${[...new Set(ALL_SPECS.map(s => s.group))].join(' | ')}`);
  console.error(`Kinds:  ${ALL_SPECS.map(s => s.kind).join(', ')}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.models) usage('--models is required');

  const models = args.models.split(',').map(s => s.trim()).filter(Boolean).map(spec => {
    const i = spec.indexOf(':');
    if (i < 1) usage(`bad model spec "${spec}" — expected provider:model`);
    return { spec, provider: spec.slice(0, i), model: spec.slice(i + 1) };
  });

  const modes = new Set((args.modes || 'pool,agent').split(',').map(s => s.trim()).filter(Boolean));
  for (const m of modes) if (!['pool', 'agent'].includes(m)) usage(`bad mode "${m}"`);

  const kindFilter = args.kinds ? new Set(args.kinds.split(',').map(s => s.trim()).filter(Boolean)) : null;
  const specs = ALL_SPECS.filter(s =>
    (s.mode === 'any' || modes.has(s.mode))
    && (!kindFilter || kindFilter.has(s.group) || kindFilter.has(s.kind)));
  if (!specs.length) usage('no kinds match the --kinds/--modes filter');

  const iterations = Math.max(1, parseInt(args.iterations || '3', 10) || 3);
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = args.out
    ? resolve(args.out)
    : join(here, 'reports', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  // Provider keys, resolved like the live controller: state/secrets.env via
  // the boot loader, plus controller/.env (the dev compose env_file — on the
  // host nothing sources it for us). Existing process env always wins.
  await loadSecretsIntoEnv().catch(() => {});
  loadDotEnv(join(dirname(fileURLToPath(import.meta.url)), '../../.env'));

  await settings.load();
  const s: any = settings.get();
  if (process.env.OLLAMA_URL) s.llm.ollamaUrl = process.env.OLLAMA_URL;

  const reporter = new Reporter(outPath, {
    models: models.map(m => m.spec),
    modes: [...modes],
    kinds: specs.map(k => k.kind),
    iterations,
    reasoning: s.llm?.reasoning ?? null,
  });
  process.on('SIGINT', () => {
    reporter.flush();
    reporter.printSummary();
    process.exit(130);
  });

  const totalCells = specs.reduce((n, k) => n + k.scenarios.length, 0);
  console.log(`\nllm-bench: ${models.length} model(s) × ${specs.length} kind(s) (${totalCells} scenario cells) × ${iterations} iteration(s)\n`);

  for (const m of models) {
    s.llm.provider = m.provider;
    s.llm.model = m.model;
    console.log(`━━ ${m.spec}`);
    let consecutiveUnreachable = 0;
    let skipRest = false;

    for (const spec of specs) {
      for (const scenario of spec.scenarios) {
        for (let i = 1; i <= iterations; i++) {
          const base: RunRecord = {
            model: m.spec, kind: spec.kind, group: spec.group, mode: spec.mode,
            scenario: scenario.name, iteration: i, outcome: 'skipped', violations: [], ms: 0,
          };
          if (skipRest) {
            reporter.add(base);
            continue;
          }
          const callsBefore = recentCalls.length;
          const t0 = Date.now();
          try {
            const out = await scenario.run();
            base.ms = Date.now() - t0;
            base.violations = scenario.check ? scenario.check(out) : [];
            base.outcome = base.violations.length ? 'violation' : 'ok';
            base.response = preview(out);
            consecutiveUnreachable = 0;
          } catch (err: any) {
            base.ms = Date.now() - t0;
            base.outcome = 'thrown';
            base.bucket = bucketError(err, isUnreachable);
            base.error = String(err?.message || err).slice(0, 200);
            if (base.bucket === 'unreachable' && ++consecutiveUnreachable >= 2) {
              console.log(`   !! ${m.spec} unreachable twice — skipping its remaining cells`);
              skipRest = true;
            }
          }
          // recentCalls is the live ring buffer (newest first, unshift on record).
          if (recentCalls.length > callsBefore) {
            base.tokens = (recentCalls[0] as any)?.usage?.total ?? null;
          }
          reporter.add(base);
          const tag = base.outcome === 'ok' ? ' ok ' : base.outcome === 'violation' ? 'VIOL' : 'FAIL';
          console.log(`   ${tag}  ${spec.kind}/${scenario.name} #${i}  ${base.ms}ms`
            + (base.violations.length ? `  [${base.violations.join(', ')}]` : '')
            + (base.bucket ? `  (${base.bucket}: ${base.error})` : ''));
        }
      }
    }
  }

  reporter.printSummary();
  const bad = reporter.records.filter(r => r.outcome === 'thrown').length;
  process.exit(bad && reporter.records.every(r => r.outcome !== 'ok') ? 1 : 0);
}

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

// Generous cap: a 400-char preview cut structured picks off before their
// `transition` field, making post-hoc analysis of the report JSON misleading.
function preview(out: unknown): string {
  try {
    const t = typeof out === 'string' ? out : JSON.stringify(out, (k, v) => (v instanceof Map ? undefined : v));
    return String(t).slice(0, 2000);
  } catch {
    return String(out).slice(0, 2000);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
