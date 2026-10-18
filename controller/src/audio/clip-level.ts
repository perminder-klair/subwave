// Evens out voice clips. A cloud voice hands back takes that differ by 10 dB
// and more from one line to the next (ElevenLabs measured -13 to -27 LUFS on
// one voice), so one speaker of an exchange lands far under the other and
// under the music. When enabled, each rendered clip is measured once, and the
// handoff trims it toward one level on top of the operator's own gain.
//
// The trim lifts as far as it cuts, where music loudness caps its lift lower
// (loudness.maxBoostDb): the quiet takes are the fault being fixed here, and
// they are whole spoken lines, not near-silent tracks. What bounds a lift is
// the total, which never leaves the operator's own range (stampedGainDb).

import { spawn } from 'node:child_process';
import { TTS_GAIN_CLAMP_DB } from '../schemas/persona.js';
import * as settings from '../settings.js';

export const VOICE_TARGET_LUFS = -18;
// A take further off than this is trimmed only this far: past it the measure
// is more likely wrong (near-silence, a cough) than the take that quiet.
export const VOICE_TRIM_MAX_DB = 12;
// Under this the clip is silence or too short for the meter's gate.
const MEASURABLE_FLOOR_LUFS = -50;
const REMEMBERED = 400;

const levels = new Map<string, number>();

export function voiceLevellingEnabled(): boolean {
  return settings.get().tts?.voiceLevelling === true;
}

// Integrated loudness from ffmpeg's ebur128 summary, or null when it has none.
export function parseIntegratedLufs(ffmpegStderr: string): number | null {
  // Only the summary: the running log above it prints an `I:` figure too.
  const at = ffmpegStderr.lastIndexOf('Summary:');
  if (at < 0) return null;
  const m = /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(ffmpegStderr.slice(at));
  if (!m) return null;
  const lufs = Number(m[1]);
  return Number.isFinite(lufs) && lufs > MEASURABLE_FLOOR_LUFS ? lufs : null;
}

export function trimDbFor(lufs: number | null | undefined): number {
  if (lufs == null) return 0;
  const trim = Math.max(-VOICE_TRIM_MAX_DB, Math.min(VOICE_TRIM_MAX_DB, VOICE_TARGET_LUFS - lufs));
  return Math.round(trim * 10) / 10;
}

// Measures a clip and remembers it for levelTrimDb. Never throws and never
// fails a render: no ffmpeg, an unreadable file or a clip too short to meter
// all leave it unmeasured, which airs at the operator's gain as before.
export function measureClipLevel(path: string, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (lufs: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A path that no longer measures must not keep an older take's figure.
      levels.delete(path);
      if (lufs != null) {
        levels.set(path, lufs);
        if (levels.size > REMEMBERED) levels.delete(levels.keys().next().value as string);
      }
      resolve(lufs);
    };
    const timer = setTimeout(() => { proc?.kill(); finish(null); }, timeoutMs);
    let proc: ReturnType<typeof spawn> | null = null;
    try {
      // framelog=verbose, not quiet: ffmpeg 5.1 (the Debian 12 build in the
      // images) has no `quiet` level, fails, and still prints a 0.0 LUFS
      // summary. At the default log level verbose frames are not printed.
      proc = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-']);
      proc.stderr?.on('data', (chunk) => { out += chunk; });
      proc.on('error', () => finish(null));
      // A failed run still prints a summary, of zeros: only a clean exit counts.
      proc.on('close', (code) => finish(code === 0 ? parseIntegratedLufs(out) : null));
    } catch {
      finish(null);
    }
  });
}

// Synchronous on purpose: the handoff to the mixer must not wait on a process.
export function levelTrimDb(path: string): number {
  return trimDbFor(levels.get(path));
}

// The operator's gain plus a take's trim, held to ±TTS_GAIN_CLAMP_DB like the
// operator's gain alone: nothing downstream limits `liq_amplify`, and a voice
// already set to the top of the dial must not be pushed past it.
export function stampedGainDb(gainDb: number, trimDb: number): number {
  const total = Math.max(-TTS_GAIN_CLAMP_DB, Math.min(TTS_GAIN_CLAMP_DB, gainDb + trimDb));
  return Math.round(total * 10) / 10;
}

// What the handoff stamps as `liq_amplify` for this clip.
export function levelledGainDb(path: string, gainDb: number): number {
  return stampedGainDb(gainDb, levelTrimDb(path));
}
