// tts-bench — renders a fixed set of DJ lines through each TTS engine and
// measures what would air: render time (cold and warm), real-time factor,
// speaking pace, loudness, true peak and the silence at each edge.
//
// Every render goes through the live tts.speak(), the path broadcast speech
// takes (normalizeForSpeech, the edge fades), with a synthetic persona naming
// the engine and voice. speak() rescues a failed engine silently, so after
// each render the bench reads the TTS stats ring and counts a rescue as a
// failure of the engine it asked for: a Piper rescue never scores as
// Chatterbox. An engine that speaks in another voice than the one asked for
// (Remote's X-TTS-Fell-Back, the sidecar's fell_back) counts the same way.
// Each engine first gets --wait seconds to report available, and one that
// never does is recorded as unavailable and not run. So is one whose named
// voice is not in the station's voice folder, which every engine would
// otherwise replace with its default and report under the asked-for name.
//
// It runs where the engines are, which is a controller container: Piper and
// Kokoro are in the image, Chatterbox and PocketTTS answer from the tts-heavy
// sidecar, and Remote is whatever --remote-url names.
//
//   docker compose -f docker-compose.dev.yml exec controller \
//     npm run tts-bench -- --engines piper,kokoro:af_heart
//
// Flags:
//   --engines     comma list of engine[:voice] (REQUIRED). cloud takes
//                 cloud:provider[:voice]. A Piper or reference voice is a
//                 filename in the station's voice folder; a remote voice is
//                 the server's own vocabulary, passed through as written.
//   --lines       comma list of line ids or categories (lines.ts); default all
//   --iterations  passes over the lines per engine (default 2). The engine's
//                 first successful render carries its model load, so it is
//                 reported as cold and kept out of the warm figures.
//   --remote-url  the Remote engine's server, for this run only
//   --wait        seconds to wait for each engine to report available (default 30)
//   --out         report directory (default scripts/tts-bench/reports/<ts>)
//
// The run works in a temp STATE_DIR seeded from the station's settings
// (test-utils/isolated-state.ts). It reads the station's voice folders and
// writes to its state root in one case only: the tts-heavy sidecar can write
// a render nowhere but the shared mount, so for Chatterbox and PocketTTS the
// run mints its own dir under the station's voice/ and removes it on exit (a
// killed run's is swept by the next). In memory it zeroes what would make one
// station's numbers unlike another's: engine speed (settings and the *_SPEED
// env vars, isolate.ts), speech corrections and voice levelling. It writes
// report.json and one clip per render under clips/. Intelligibility and
// naturalness are scored afterwards by score.py, which needs neither the
// station nor the engines.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RemoteEngine } from '../../src/audio/ttsHeavyClient.js';
import { resolveActiveStationDir } from '../../src/stations/resolve.js';
import { isolateStationState, sweepAbandonedDirs } from '../test-utils/isolated-state.js';
import { neutralizeEngineEnv, shareStationVoices } from './isolate.js';
import { LINES, type BenchLine } from './lines.js';
import {
  CLIP_ANALYSIS_FILTER, clipFlags, flagPace, formatSummary, parseDurationSec, parseEdgeSilenceMs,
  parseEngineSpec, parseTruePeakDb, summarize, voiceSubstitution, type BenchRecord, type EngineSpec,
  type EngineSummary,
} from './measure.js';

// Every src/ import is dynamic and comes after these calls: config.ts fixes its
// state root, voice folder and engine speeds at import, and a static import
// would be evaluated first. (stations/resolve.ts is leaf-level by design.)
const { sourceRoot, dir: isolatedStateDir } = isolateStationState('subwave-tts-bench-');
const stationDir = resolveActiveStationDir(sourceRoot);
const neutralizedEnv = neutralizeEngineEnv(process.env);
// The station's own render dir, on the mount the sidecar shares: an operator's
// PIPER_OUT, else config.ts's default under the station's state dir.
const stationVoiceOut = neutralizedEnv.PIPER_OUT || join(stationDir, 'voice');
const voiceDir = shareStationVoices(stationDir, isolatedStateDir, process.env);
const settings = await import('../../src/settings.js');
const tts = await import('../../src/audio/tts.js');
const remoteTts = await import('../../src/audio/remoteTts.js');
const ttsHeavy = await import('../../src/audio/ttsHeavyClient.js');
const piper = await import('../../src/audio/piper.js');
const chatterbox = await import('../../src/audio/chatterbox.js');
const { ttsCalls } = await import('../../src/stats.js');
const { parseIntegratedLufs } = await import('../../src/audio/clip-level.js');
const { loadSecretsIntoEnv } = await import('../../src/setup/secrets.js');

// The engines the tts-heavy sidecar renders when TTS_HEAVY_URL is set. It
// writes each WAV to a path the controller names, which has to be on the mount
// both containers share.
const SIDECAR_ENGINES: Record<RemoteEngine, true> = { chatterbox: true, 'pocket-tts': true };
const isSidecarEngine = (engine: string) => Object.hasOwn(SIDECAR_ENGINES, engine);
// <prefix><pid>-<6 chars>, the name sweepAbandonedDirs() matches.
const SIDECAR_DIR_PREFIX = 'tts-bench-';
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

// The dispatcher's own answer, so the bench never runs an engine speak() would
// have rerouted before it started.
function usable(spec: EngineSpec): boolean {
  return tts.engineUsable(spec.engine, spec.cloudProvider ?? null);
}

// A voice that does not resolve is replaced without a word in the stats ring:
// Piper falls back to its baked-in voice, a reference WAV to the engine's
// default. So a named voice is checked against the listings the admin voice
// dropdowns read, before the engine runs. Null when there is nothing to check.
async function missingVoice(spec: EngineSpec): Promise<string | null> {
  const voice = spec.voice;
  if (!voice) return null;
  if (spec.engine === 'piper') {
    return (await piper.listPiperVoices()).includes(voice)
      ? null
      : `Piper voice "${voice}" (an .onnx beside its .onnx.json) is not in ${voiceDir}`;
  }
  // Chatterbox takes only a reference WAV; PocketTTS takes one or a built-in voice id.
  if (spec.engine === 'chatterbox' || (spec.engine === 'pocket-tts' && /\.wav$/i.test(voice))) {
    if (isAbsolute(voice)) return existsSync(voice) ? null : `reference voice ${voice} does not exist`;
    return (await chatterbox.listReferenceVoices()).includes(voice)
      ? null
      : `reference voice "${voice}" is not in ${voiceDir}`;
  }
  return null;
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
  spec: EngineSpec, line: BenchLine, iteration: number, cold: boolean, outDir: string, sidecarOut: string | null,
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
  // Everything else renders into the isolated state dir; the sidecar can only
  // reach the shared mount.
  const outPath = sidecarOut && isSidecarEngine(spec.engine)
    ? join(sidecarOut, `${slug(spec.label)}-${line.id}.${iteration}.wav`)
    : undefined;
  const before = ttsCalls[0];
  // A voice substitution shows only as the engine's warning (measure.ts
  // voiceSubstitution). Renders run one at a time, so a warning logged inside
  // this window is this render's.
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
    warn(...args);
  };
  const t0 = performance.now();
  let path: string | null = null;
  try {
    // speedScale 1 replaces the persona x daypart term, so the hour the bench
    // runs at does not change the pace.
    path = await tts.speak(line.text, { kind: 'bench', persona, speedScale: 1, outPath });
  } catch (err: any) {
    rec.error = String(err?.message || err).slice(0, 300);
  } finally {
    console.warn = warn;
  }
  rec.ms = Math.round(performance.now() - t0);

  const call = ttsCalls[0] !== before ? ttsCalls[0] : null;
  if (call) {
    rec.chars = call.chars;
    rec.sentText = call.text;
  }
  const rescued = !!call && (call.fellBack || call.engine !== spec.engine);
  if (rescued) rec.engineUsed = call.engine;
  const substituted = voiceSubstitution(warnings);
  if (substituted) rec.voiceUsed = `${substituted.used} (${substituted.reason})`;
  if (!path) return rec;
  rec.outcome = rescued || substituted ? 'fell-back' : 'ok';

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

  const lineFilter = args.lines ? new Set(args.lines.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const lines = LINES.filter((l) => !lineFilter || lineFilter.has(l.id) || lineFilter.has(l.category));
  if (!lines.length) usage('no lines match --lines');

  // The sidecar writes where the controller tells it, and only the shared mount
  // reaches it: a run-owned dir under the station's voice/, removed on exit.
  let sidecarOut: string | null = null;
  if (specs.some((spec) => isSidecarEngine(spec.engine)) && ttsHeavy.isRemoteEnabled()) {
    if (!existsSync(stationVoiceOut)) {
      usage(`chatterbox and pocket-tts render in the tts-heavy sidecar, which can only write to the shared state mount, `
        + `and the station's voice dir ${stationVoiceOut} is not here. Run the bench in the controller container.`);
    }
    sweepAbandonedDirs(stationVoiceOut, SIDECAR_DIR_PREFIX);
    const minted = mkdtempSync(join(stationVoiceOut, `${SIDECAR_DIR_PREFIX}${process.pid}-`));
    process.once('exit', () => rmSync(minted, { recursive: true, force: true }));
    sidecarOut = minted;
  }

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
      voiceDir,
      // Env the run removed before importing src/ (isolate.ts), as it found it.
      neutralizedEnv,
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
  console.log(`Isolated STATE_DIR: ${isolatedStateDir}`);
  console.log(`Voices: ${voiceDir}`);
  if (Object.keys(neutralizedEnv).length) console.log(`Ignoring: ${Object.keys(neutralizedEnv).join(', ')}`);
  console.log('');

  const voiceProblems = new Map<string, string>();
  for (const spec of specs) {
    const problem = await missingVoice(spec);
    if (problem) voiceProblems.set(spec.label, problem);
  }

  // One wait for all of them: the probes run concurrently. Remote's own loop
  // re-probes every 30s, so nudge it while waiting.
  const waiting = specs.filter((spec) => !voiceProblems.has(spec.label));
  const deadline = Date.now() + waitSec * 1000;
  while (waiting.some((spec) => !usable(spec)) && Date.now() < deadline) {
    if (waiting.some((spec) => spec.engine === 'remote' && !usable(spec))) await remoteTts.refresh();
    await sleep(500);
  }

  for (const spec of specs) {
    console.log(`━━ ${spec.label}`);
    const skip = voiceProblems.get(spec.label) ?? (usable(spec) ? null : `not available after ${waitSec}s`);
    if (skip) {
      console.log(`   !! ${skip}, skipped`);
      report.records.push({
        engine: spec.label, line: '-', category: '-', iteration: 0, cold: false,
        outcome: 'unavailable', ms: 0, chars: 0, flags: [], error: skip,
      });
      flush();
      continue;
    }
    let cold = true;
    let failures = 0;
    for (let iteration = 1; iteration <= iterations && failures < MAX_CONSECUTIVE_FAILURES; iteration++) {
      for (const line of lines) {
        const rec = await renderOne(spec, line, iteration, cold, outDir, sidecarOut);
        // The model load rides on the first render that succeeds: one that
        // failed or fell back may never have loaded it, and the render after
        // it would carry the load into the warm figures.
        if (rec.outcome === 'ok') cold = false;
        report.records.push(rec);
        flush();
        failures = rec.outcome === 'ok' ? 0 : failures + 1;
        const tag = rec.outcome === 'ok' ? ' ok ' : rec.outcome === 'fell-back' ? 'RESC' : 'FAIL';
        console.log(`   ${tag}  ${line.id} #${iteration}${rec.cold ? ' (cold)' : ''}  ${rec.ms}ms`
          + (rec.audioSec ? `  ${rec.audioSec}s audio  RTF ${rec.rtf}` : '')
          + (rec.lufs != null ? `  ${rec.lufs} LUFS` : '')
          + (rec.flags.length ? `  [${rec.flags.join(', ')}]` : '')
          + (rec.engineUsed ? `  (spoke as ${rec.engineUsed})` : '')
          + (rec.voiceUsed ? `  (voice ${rec.voiceUsed})` : '')
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
