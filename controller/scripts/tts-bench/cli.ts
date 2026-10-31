// tts-bench — renders a fixed set of DJ lines through each TTS engine and
// measures what would air: render time (cold and warm), real-time factor,
// speaking pace, loudness, true peak and the silence at each edge.
//
// Every render goes through the live tts.speak(), the path broadcast speech
// takes (normalizeForSpeech, the edge fades), with a synthetic persona naming
// the engine and voice. speak() rescues a failed engine silently, so after
// each render the bench reads the TTS stats ring and counts a rescue as a
// failure of the engine it asked for: a Piper rescue never scores as
// Chatterbox. Each engine first gets --wait seconds to report available, and
// one that never does is recorded as unavailable and not run.
//
// It runs where the engines are, which is a controller container: Piper and
// Kokoro are in the image, Chatterbox and PocketTTS answer from the tts-heavy
// sidecar, and Remote is whatever --remote-url names.
//
//   docker compose -f docker-compose.dev.yml exec controller \
//     npm run tts-bench -- --engines piper,kokoro:af_heart
//
// The sidecar writes each WAV to a path the controller names, which must be
// on the shared /var/sub-wave mount, and this run's temp state dir is not. Set
// PIPER_OUT=/var/sub-wave/voice/tts-bench for chatterbox or pocket-tts.
//
// Flags:
//   --engines     comma list of engine[:voice] (REQUIRED). cloud takes
//                 cloud:provider[:voice]. A remote voice is the server's own
//                 vocabulary, passed through as written.
//   --lines       comma list of line ids or categories (lines.ts); default all
//   --iterations  passes over the lines per engine (default 2). The engine's
//                 first render carries its model load, so it is reported as
//                 cold and kept out of the warm figures.
//   --remote-url  the Remote engine's server, for this run only
//   --wait        seconds to wait for each engine to report available (default 30)
//   --out         report directory (default scripts/tts-bench/reports/<ts>)
//
// The run works in a temp STATE_DIR seeded from the station's settings
// (test-utils/isolated-state.ts) and never writes to state/. In memory it
// zeroes what would make one station's numbers unlike another's: engine speed,
// speech corrections and voice levelling. It writes report.json and one clip
// per render under clips/. Intelligibility and naturalness are scored
// afterwards by score.py, which needs neither the station nor the engines.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateStationState } from '../test-utils/isolated-state.js';
import { LINES, type BenchLine } from './lines.js';
import {
  CLIP_ANALYSIS_FILTER, clipFlags, flagPace, formatSummary, parseDurationSec, parseEdgeSilenceMs,
  parseEngineSpec, parseTruePeakDb, summarize, type BenchRecord, type EngineSpec, type EngineSummary,
} from './measure.js';

// Every src/ import is dynamic and comes after this call: config.ts fixes its
// state root at import, and a static import would be evaluated first.
const { dir: isolatedStateDir } = isolateStationState('subwave-tts-bench-');
const settings = await import('../../src/settings.js');
const tts = await import('../../src/audio/tts.js');
const remoteTts = await import('../../src/audio/remoteTts.js');
const { ttsCalls } = await import('../../src/stats.js');
const { parseIntegratedLufs } = await import('../../src/audio/clip-level.js');
const { loadSecretsIntoEnv } = await import('../../src/setup/secrets.js');

// The heavy engines answer from the sidecar, which writes to the path it is
// handed: it has to be one both containers mount.
const SIDECAR_ENGINES = new Set(['chatterbox', 'pocket-tts']);
// An engine that fails this many renders in a row is not going to recover
// mid-run; the rest of its cells would only measure the rescue chain.
const MAX_CONSECUTIVE_FAILURES = 3;

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
  console.error('Usage: npm run tts-bench -- --engines engine[:voice][,...] '
    + '[--lines id|category,...] [--iterations N] [--remote-url URL] [--wait S] [--out DIR]');
  console.error(`Engines:    ${tts.ENGINES.join(', ')}`);
  console.error(`Categories: ${[...new Set(LINES.map((l) => l.category))].join(', ')}`);
  console.error(`Lines:      ${LINES.map((l) => l.id).join(', ')}`);
  process.exit(2);
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

function usable(spec: EngineSpec): boolean {
  const available: any = tts.availableEngines();
  if (spec.engine === 'cloud') return available.cloudByProvider?.[spec.cloudProvider!] ?? available.cloud;
  return available[spec.engine] === true;
}

// One ffmpeg pass per clip; the parsers in measure.ts read its stderr. A
// failed or hung run returns '' and the clip is flagged unmeasured.
function analyzeClipStderr(file: string): Promise<string> {
  return new Promise((done) => {
    let stderr = '';
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', CLIP_ANALYSIS_FILTER, '-f', 'null', '-']);
    const timer = setTimeout(() => proc.kill(), 30_000);
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', () => { clearTimeout(timer); done(''); });
    proc.on('close', (code) => { clearTimeout(timer); done(code === 0 ? stderr : ''); });
  });
}

async function measureClip(file: string, rec: BenchRecord): Promise<void> {
  const stderr = await analyzeClipStderr(file);
  const durationSec = parseDurationSec(stderr);
  if (!durationSec) {
    rec.flags.push('unmeasured');
    return;
  }
  const { leadMs, trailMs } = parseEdgeSilenceMs(stderr, durationSec);
  rec.audioSec = round(durationSec, 2);
  rec.rtf = round(rec.ms / 1000 / durationSec, 3);
  // Pace over the voiced span: a long tail is its own flag, not a slow voice.
  rec.cps = round(rec.chars / Math.max(0.1, durationSec - (leadMs + trailMs) / 1000), 1);
  rec.lufs = parseIntegratedLufs(stderr);
  rec.truePeakDb = parseTruePeakDb(stderr);
  rec.leadMs = leadMs;
  rec.trailMs = trailMs;
  rec.flags.push(...clipFlags(rec));
}

async function renderOne(
  spec: EngineSpec, line: BenchLine, iteration: number, cold: boolean, outDir: string,
): Promise<BenchRecord> {
  const rec: BenchRecord = {
    engine: spec.label, line: line.id, category: line.category, iteration, cold,
    outcome: 'thrown', ms: 0, chars: line.text.length, flags: [],
  };
  const persona = {
    id: 'tts-bench',
    name: 'TTS Bench',
    language: line.language || '',
    tts: { engine: spec.engine, voice: spec.voice, ...(spec.cloudProvider ? { cloudProvider: spec.cloudProvider } : {}) },
  };
  const before = ttsCalls[0];
  const t0 = performance.now();
  let path: string | null = null;
  try {
    // speedScale 1 replaces the persona x daypart term, so the hour the bench
    // runs at does not change the pace.
    path = await tts.speak(line.text, { kind: 'bench', persona, speedScale: 1 });
  } catch (err: any) {
    rec.error = String(err?.message || err).slice(0, 300);
  }
  rec.ms = Math.round(performance.now() - t0);

  const call = ttsCalls[0] !== before ? ttsCalls[0] : null;
  if (call) {
    rec.chars = call.chars;
    rec.sentText = call.text;
  }
  const rescued = !!call && (call.fellBack || call.engine !== spec.engine);
  if (rescued) rec.engineUsed = call.engine;
  if (!path) return rec;
  rec.outcome = rescued ? 'fell-back' : 'ok';

  rec.clip = join('clips', slug(spec.label), `${line.id}.${iteration}${extname(path) || '.wav'}`);
  const dest = join(outDir, rec.clip);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(path, dest);
  rmSync(path, { force: true });
  if (rec.outcome === 'ok') await measureClip(dest, rec);
  return rec;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.engines) usage('--engines is required');

  const specs = args.engines.split(',').map((s) => s.trim()).filter(Boolean).map(parseEngineSpec);
  for (const spec of specs) {
    if (!tts.ENGINES.includes(spec.engine)) usage(`unknown engine "${spec.engine}" in "${spec.label}"`);
    if (spec.engine === 'cloud' && !spec.cloudProvider) usage(`"${spec.label}": cloud needs a provider, e.g. cloud:openai:alloy`);
  }
  const dupe = specs.find((s, i) => specs.findIndex((t) => t.label === s.label) !== i);
  if (dupe) usage(`"${dupe.label}" is listed twice`);
  if (process.env.TTS_HEAVY_URL && !process.env.PIPER_OUT && specs.some((s) => SIDECAR_ENGINES.has(s.engine))) {
    usage('chatterbox and pocket-tts render in the tts-heavy sidecar, which can only write to the shared mount. '
      + 'Set PIPER_OUT=/var/sub-wave/voice/tts-bench.');
  }

  const lineFilter = args.lines ? new Set(args.lines.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const lines = LINES.filter((l) => !lineFilter || lineFilter.has(l.id) || lineFilter.has(l.category));
  if (!lines.length) usage('no lines match --lines');

  const iterations = Math.max(1, parseInt(args.iterations || '2', 10) || 2);
  const waitSec = Math.max(0, Number(args.wait ?? 30) || 0);
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(args.out || join(here, 'reports', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(outDir, { recursive: true });

  await loadSecretsIntoEnv().catch(() => {});
  await settings.load();
  const s: any = settings.get();
  s.tts.speed = {};
  s.tts.corrections = [];
  s.tts.voiceLevelling = false;
  if (args['remote-url']) s.tts.remote = { ...(s.tts.remote || {}), url: args['remote-url'].replace(/\/+$/, '') };
  remoteTts.start();
  await remoteTts.refresh();

  const report = {
    meta: {
      startedAt: new Date().toISOString(),
      version: process.env.SUBWAVE_BUILD_VERSION || null,
      host: {
        arch: process.arch,
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model || null,
        memGb: round(totalmem() / 2 ** 30, 1),
        container: existsSync('/.dockerenv'),
      },
      engines: specs.map((spec) => spec.label),
      iterations,
      remoteUrl: s.tts.remote?.url || null,
    },
    lines: lines.map(({ id, category, text, spoken, language }) => ({
      id, category, text, spoken: spoken || null, language: language || null,
    })),
    records: [] as BenchRecord[],
    summary: null as EngineSummary[] | null,
  };
  const reportPath = join(outDir, 'report.json');
  const flush = () => writeFileSync(reportPath, JSON.stringify(report, null, 1));
  const finish = () => {
    flagPace(report.records);
    report.summary = summarize(report.records);
    flush();
    console.log(`\n${formatSummary(report.summary)}`);
    console.log(`\nReport: ${reportPath}`);
  };
  process.on('SIGINT', () => {
    finish();
    process.exit(130);
  });

  console.log(`\ntts-bench: ${specs.length} engine(s) × ${lines.length} line(s) × ${iterations} iteration(s)`);
  console.log(`Host: ${report.meta.host.arch}, ${report.meta.host.cpus} × ${report.meta.host.cpuModel}`);
  console.log(`Isolated STATE_DIR: ${isolatedStateDir}\n`);

  // One wait for all of them: the probes run concurrently. Remote's own loop
  // re-probes every 30s, so nudge it while waiting.
  const deadline = Date.now() + waitSec * 1000;
  while (specs.some((spec) => !usable(spec)) && Date.now() < deadline) {
    if (specs.some((spec) => spec.engine === 'remote' && !usable(spec))) await remoteTts.refresh();
    await sleep(500);
  }

  for (const spec of specs) {
    console.log(`━━ ${spec.label}`);
    if (!usable(spec)) {
      console.log(`   !! not available after ${waitSec}s, skipped`);
      report.records.push({
        engine: spec.label, line: '-', category: '-', iteration: 0, cold: false,
        outcome: 'unavailable', ms: 0, chars: 0, flags: [],
      });
      flush();
      continue;
    }
    let cold = true;
    let failures = 0;
    for (let iteration = 1; iteration <= iterations && failures < MAX_CONSECUTIVE_FAILURES; iteration++) {
      for (const line of lines) {
        const rec = await renderOne(spec, line, iteration, cold, outDir);
        cold = false;
        report.records.push(rec);
        flush();
        failures = rec.outcome === 'ok' ? 0 : failures + 1;
        const tag = rec.outcome === 'ok' ? ' ok ' : rec.outcome === 'fell-back' ? 'RESC' : 'FAIL';
        console.log(`   ${tag}  ${line.id} #${iteration}${rec.cold ? ' (cold)' : ''}  ${rec.ms}ms`
          + (rec.audioSec ? `  ${rec.audioSec}s audio  RTF ${rec.rtf}` : '')
          + (rec.lufs != null ? `  ${rec.lufs} LUFS` : '')
          + (rec.flags.length ? `  [${rec.flags.join(', ')}]` : '')
          + (rec.engineUsed ? `  (spoke as ${rec.engineUsed})` : '')
          + (rec.error ? `  (${rec.error})` : ''));
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`   !! ${spec.label} failed ${failures} renders in a row, skipping the rest`);
          break;
        }
      }
    }
  }

  finish();
  console.log(`Score intelligibility and naturalness off the station: uv run scripts/tts-bench/score.py ${outDir}`);
  process.exit(report.records.some((r) => r.outcome === 'ok') ? 0 : 1);
}

await main();
