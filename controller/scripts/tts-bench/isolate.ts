// What tts-bench changes in the environment before it imports src/: config.ts
// reads env once, at import, so every step here has to run first. Nothing here
// imports src/, so scripts/tts-bench-measure.test.ts pins it without a station.
//
// isolateStationState() moves STATE_DIR to a temp dir and copies only the
// station's keys. Two things a TTS run needs did not come with it, and one
// thing it brings along would make one station's numbers unlike another's:
//
// - The voice folders. config.ts puts them under STATE_DIR (voices/, and the
//   legacy chatterbox-voices/), so in the temp dir they are empty: a named
//   Piper voice resolved to the baked-in default and was reported under the
//   name that was asked for, and a clone reference went to the sidecar as a
//   temp path it cannot read. shareStationVoices() points the run at the
//   station's own folders, which the run only reads.
// - The engine speed env vars, which multiply inside piper.ts, kokoro.ts and
//   the cloud engine regardless of settings.tts.speed. PIPER_OUT goes too: an
//   operator's value names the station's own render dir, and the bench renders
//   into its temp dir instead (cli.ts mints a run-owned dir on the shared
//   mount for the sidecar engines, which cannot write anywhere else).

import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

// Every engine speed config.ts reads from env. scripts/tts-bench-measure.test.ts
// fails when config.ts grows one this list lacks.
export const ENGINE_SPEED_ENV = ['TTS_SPEED', 'PIPER_SPEED', 'KOKORO_SPEED', 'CLOUD_TTS_SPEED'] as const;

// Remove the engine speed vars and PIPER_OUT from `env`. Returns what was
// removed, for the report.
export function neutralizeEngineEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const removed: Record<string, string> = {};
  for (const name of [...ENGINE_SPEED_ENV, 'PIPER_OUT']) {
    if (env[name] === undefined) continue;
    removed[name] = env[name]!;
    delete env[name];
  }
  return removed;
}

// Point the run at the station's voice folders. TTS_VOICE_DIR (and its older
// name CHATTERBOX_VOICE_DIR) is config.ts's override for voices/, and the real
// path is what the tts-heavy sidecar needs to read a reference WAV. An
// operator's own value already names the station's folder and is kept. The
// legacy folder has no env override, so it is linked into the temp dir; a
// sidecar cannot follow that link, which the station's own log already flags
// ("move them to voices/"). A folder the station does not have is left alone,
// never created. Returns the voices/ folder a named voice has to be in: the
// operator's, else the station's, which is what a missing voice is reported
// against even when the station has none yet.
export function shareStationVoices(stationDir: string, isolatedDir: string, env: NodeJS.ProcessEnv): string {
  const legacy = join(stationDir, 'chatterbox-voices');
  if (existsSync(legacy)) symlinkSync(legacy, join(isolatedDir, 'chatterbox-voices'));
  const own = env.TTS_VOICE_DIR || env.CHATTERBOX_VOICE_DIR;
  if (own) return own;
  const voices = join(stationDir, 'voices');
  if (existsSync(voices)) env.TTS_VOICE_DIR = voices;
  return voices;
}
