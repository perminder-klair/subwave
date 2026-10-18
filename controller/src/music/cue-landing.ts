// Where a `liq_cue_in` actually lands (#2003).
//
// On Liquidsoap 2.4.x the cue-in is applied once, at request resolution: the
// ffmpeg decoder (the default, above the native flac/mad decoders) seeks to a
// packet boundary, drops every packet whose pts is below the cue and emits the
// first one at or after it WHOLE. Nothing trims inside that packet, so the
// track starts on the next codec-frame boundary at or after the cue:
//
//     late = first packet pts >= cue  -  cue      (0 … one codec frame)
//
// For a 4096-sample FLAC that is up to ~93 ms, for a 1152-sample MP3 ~26 ms.
// Inaudible after silence or under a crossfade with unrelated audio, but at a
// stem-blend clip -> Y seam both sides are Y's own audio, so a late Y is a
// comb filter (2.9 ms) or a flam (tens of ms). The controller probes the
// packets around the cue here and stamps the result on Y as
// `liq_clip_cue_late`; radio.liq's dj_transition delays Y by it at clip -> Y.
//
// Only codecs whose prediction `scripts/stem-seam-test.sh cuein` validated
// against real Liquidsoap renders carry a rule. Anything else returns null and
// the seam aligns on the stamped cue, exactly as before the probe existed.
// A decoder-priority change or a Liquidsoap image bump must re-run that mode.

import { spawn } from 'node:child_process';

// Writer-side bound; radio.liq enforces the same bound (and < clip lead).
export const CUE_LATE_MAX_SEC = 0.15;

// Float slack for a cue that sits exactly on a packet boundary: Liquidsoap
// keeps a packet whose pts equals the target.
const PTS_EPSILON_SEC = 1e-6;

export interface CodecRule {
  // Subtract the stream's start_time. An MP3 with a LAME/Xing header reports
  // its encoder delay (1105 samples for LAME) as start_time; packet pts count
  // it, the analyzer's gapless decode (and so the clip's stems) does not, and
  // Liquidsoap does not skip it after a seek: Y's first sample sits
  // start_time EARLIER on the analyzer timeline than its packet pts says.
  subtractStartTime: boolean;
  // A packet starting exactly on the cue is dropped too (measured for AAC in
  // MP4: the packet at the seek point never reaches the output).
  exclusiveBoundary: boolean;
}

// Keyed by ffprobe `codec_name`. Filled ONLY from codecs that the `cuein`
// measurement predicted within one sample on Liquidsoap 2.4.6, at every cue
// tried (docs/stem-transitions-research.md, "Cue-in landing"). Vorbis and
// Opus go through Liquidsoap's native ogg decoder and land thousands of
// samples off either way; WAV seeks do not follow the packet rule. A codec
// missing here is "not compensated": no stamp, today's alignment.
export const CODEC_RULES: Readonly<Record<string, CodecRule>> = Object.freeze({
  flac: { subtractStartTime: false, exclusiveBoundary: false },
  alac: { subtractStartTime: false, exclusiveBoundary: false },
  mp3: { subtractStartTime: true, exclusiveBoundary: false },
  aac: { subtractStartTime: false, exclusiveBoundary: true },
});

export interface CuePacket { pts: number }

// Pure: how late a cue lands given the packet start times (seconds) around
// it, on the timeline the clip's stems were cut from. Null when no packet
// starts at or after the cue, or when the result is outside
// [0, CUE_LATE_MAX_SEC): a NEGATIVE result (an MP3 whose encoder delay puts Y
// early) cannot be fixed by delaying Y, so it is not stamped.
export function cueLateSec(packets: CuePacket[], cueSec: number, rule: CodecRule | null | undefined,
  startTimeSec: number | null = null): number | null {
  if (!rule || !Number.isFinite(cueSec)) return null;
  let first: number | null = null;
  for (const p of packets) {
    if (!Number.isFinite(p.pts)) continue;
    const after = rule.exclusiveBoundary ? p.pts > cueSec + PTS_EPSILON_SEC : p.pts >= cueSec - PTS_EPSILON_SEC;
    if (!after) continue;
    if (first == null || p.pts < first) first = p.pts;
  }
  if (first == null) return null;
  const start = rule.subtractStartTime && Number.isFinite(startTimeSec) ? Number(startTimeSec) : 0;
  const late = Math.max(0, first - cueSec) - start;
  if (late < 0 && late > -PTS_EPSILON_SEC) return 0;
  return late >= 0 && late < CUE_LATE_MAX_SEC ? late : null;
}

// The plain packet rule (inclusive boundary, no start_time): what the
// `cuein` harness compares against for every codec, validated or not.
export const RAW_PACKET_RULE: CodecRule = Object.freeze({ subtractStartTime: false, exclusiveBoundary: false });

// Stream URLs carry Subsonic u/t/s query credentials; never log them. Same
// shape as radio.liq's redact_subhttp_uri, plus bare credential params in
// free text (ffprobe stderr quotes the URL it failed on).
export function redactSource(text: string): string {
  return String(text ?? '')
    .replace(/\?[^#\s'"]*/g, '?[redacted]')
    .replace(/#[^\s'"]*/g, '')
    .replace(/\b([utsp])=[^&\s'"]*/g, '$1=[redacted]');
}

export interface CuePacketProbe {
  codec: string;
  sampleRate: number | null;
  startTimeSec: number | null;
  packets: CuePacket[];
}

export type CueLanding =
  | { ok: true; lateSec: number; codec: string; rawLateSec: number }
  | { ok: false; codec: string | null; reason: string };

function parseRational(s: unknown): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(String(s ?? ''));
  if (!m || Number(m[2]) === 0) return null;
  return Number(m[1]) / Number(m[2]);
}

// Parse `ffprobe -of json` output (stream + packet entries). Exported for tests.
export function parseProbeJson(json: string): CuePacketProbe | null {
  type ProbeDoc = {
    streams?: Array<{ codec_name?: unknown; sample_rate?: unknown; time_base?: unknown; start_time?: unknown }>;
    packets?: Array<{ pts?: unknown; pts_time?: unknown }>;
  };
  let doc: ProbeDoc | null;
  try { doc = JSON.parse(json) as ProbeDoc; } catch { return null; }
  const stream = Array.isArray(doc?.streams) ? doc.streams[0] : null;
  if (!stream || typeof stream.codec_name !== 'string') return null;
  const tb = parseRational(stream.time_base);
  const packets: CuePacket[] = [];
  for (const p of Array.isArray(doc.packets) ? doc.packets : []) {
    // Integer pts × time_base where possible: pts_time is printed to 6 dp,
    // which is coarser than one sample.
    const pts = tb != null && p?.pts != null && Number.isFinite(Number(p.pts)) ? Number(p.pts) * tb
      : Number(p?.pts_time);
    if (Number.isFinite(pts)) packets.push({ pts });
  }
  const sr = Number(stream.sample_rate);
  const start = Number(stream.start_time);
  return {
    codec: stream.codec_name,
    sampleRate: Number.isFinite(sr) && sr > 0 ? sr : null,
    startTimeSec: Number.isFinite(start) ? start : null,
    packets,
  };
}

// Run ffprobe on the packets around the cue. Never throws: null on a missing
// ffprobe, a timeout, a non-zero exit or unparseable output (`reason` says
// which, already redacted).
export function probeCuePackets(source: string, cueSec: number, { timeoutMs = 2000 } = {}):
  Promise<{ probe: CuePacketProbe | null; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (probe: CuePacketProbe | null, reason: string) => {
      if (settled) return;
      settled = true;
      resolve({ probe, reason: redactSource(reason) });
    };
    try {
      const from = Math.max(0, cueSec - 2);
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,time_base,start_time:packet=pts,pts_time',
        '-read_intervals', `${from.toFixed(3)}%${(cueSec + 1).toFixed(3)}`,
        '-of', 'json',
        source,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString(); });
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        done(null, `ffprobe timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      proc.on('error', (e) => { clearTimeout(timer); done(null, `ffprobe unavailable: ${e.message}`); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return done(null, `ffprobe exit ${code}: ${err.trim().slice(-300)}`);
        const probe = parseProbeJson(out);
        done(probe, probe ? 'ok' : 'unparseable ffprobe output');
      });
    } catch (e) {
      done(null, `ffprobe failed to start: ${(e as Error)?.message ?? e}`);
    }
  });
}

// Probe how late Y's cue-in will land. Never throws.
export async function probeCueLanding(source: string, cueSec: number, opts: { timeoutMs?: number } = {}): Promise<CueLanding> {
  if (!source || !Number.isFinite(cueSec) || cueSec <= 0) return { ok: false, codec: null, reason: 'no cue' };
  try {
    const { probe, reason } = await probeCuePackets(source, cueSec, opts);
    if (!probe) return { ok: false, codec: null, reason };
    const rule = CODEC_RULES[probe.codec];
    if (!rule) return { ok: false, codec: probe.codec, reason: 'codec not validated' };
    const raw = cueLateSec(probe.packets, cueSec, RAW_PACKET_RULE);
    const late = cueLateSec(probe.packets, cueSec, rule, probe.startTimeSec);
    if (raw == null) return { ok: false, codec: probe.codec, reason: 'no packet at or after the cue' };
    if (late == null) return { ok: false, codec: probe.codec, reason: `lands ${((raw - (rule.subtractStartTime ? probe.startTimeSec ?? 0 : 0)) * 1000).toFixed(1)}ms off — outside the delayable range` };
    return { ok: true, lateSec: late, codec: probe.codec, rawLateSec: raw };
  } catch (e) {
    return { ok: false, codec: null, reason: redactSource(`probe failed: ${(e as Error)?.message ?? e}`) };
  }
}

export async function probeCueLate(source: string, cueSec: number, opts: { timeoutMs?: number } = {}):
  Promise<{ lateSec: number; codec: string } | null> {
  const r = await probeCueLanding(source, cueSec, opts);
  return r.ok ? { lateSec: r.lateSec, codec: r.codec } : null;
}
