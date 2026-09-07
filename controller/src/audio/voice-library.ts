// The shared voice-clone reference folder — state/voices/ plus the legacy
// pre-#213 state/chatterbox-voices/. Chatterbox and PocketTTS both clone from
// the WAVs in here (a persona's `tts.voice` is one of these filenames), and
// custom Piper .onnx voices live alongside them.
//
// This module is the SINGLE scanner of those directories: chatterbox.ts's
// listReferenceVoices() delegates to scan(), and the admin /voices routes use
// list()/importVoice()/removeVoice()/resolve(). Two entry points on purpose —
// GET /settings calls the listing path on every 3s admin poll, so scan() stays
// readdir+stat and never spawns a subprocess; only list() probes durations.
//
// Deliberately NO JSON sidecar (unlike broadcast/sfx.ts). This folder is
// documented as operator-writable by hand and dropping files in over FTP keeps
// working — a sidecar would carry no entry for those files and go stale the
// moment someone used the old route. Durations are memoised on size+mtime
// instead, which covers hand-dropped files too.

import { readdir, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { slugify } from '../util/slug.js';
import { uniqueFilename } from '../personas/bundle-pure.js';
import {
  transcodeAudio, hasFfmpeg, extOf, baseName, isAcceptedAudio, probeDurationSec,
} from './audio-import.js';

// Advisory band for a reference clip. Under the floor there may not be enough
// signal for a stable clone; over the ceiling every render gets slower without
// sounding better. Advisory ONLY — nothing here truncates or refuses on length.
export const ADVISORY_MIN_SEC = 4;
export const ADVISORY_MAX_SEC = 20;

// Canonical stored form. Both cloning workers resample internally, so mono
// 24 kHz is a safe common denominator that also keeps the files small.
const TARGET_SAMPLE_RATE = 24_000;
const TARGET_CHANNELS = 1;

export type VoiceWarning = 'short' | 'long' | null;

export type VoiceFile = {
  file: string;
  dir: string;
  path: string;
  legacy: boolean;
  size: number;
  mtimeMs: number;
};

export type VoiceEntry = {
  file: string;
  size: number;
  legacy: boolean;
  durationSec: number | null;
  warning: VoiceWarning;
};

// Pure. An unknown duration (no ffprobe on a bare-host dev box) is "no advice",
// never "bad" — the UI must not scold an operator over a missing tool.
export function voiceWarning(durationSec: number | null | undefined): VoiceWarning {
  if (durationSec == null || !Number.isFinite(durationSec)) return null;
  if (durationSec < ADVISORY_MIN_SEC) return 'short';
  if (durationSec > ADVISORY_MAX_SEC) return 'long';
  return null;
}

// The on-disk filename for an operator-supplied name. Always `.wav` — scan()
// filters on that extension and the workers need real WAV bytes. An audio
// extension the operator typed is stripped first so "morgan.wav" doesn't
// become "morgan-wav.wav" via slugify's dot handling.
export function voiceFileName(name: string): string {
  const raw = String(name || '').trim();
  const stem = isAcceptedAudio(raw) ? baseName(raw) : raw;
  const slug = slugify(stem);
  if (!slug) throw new Error('Voice name is required');
  return `${slug}.wav`;
}

async function scanDir(dir: string, legacy: boolean): Promise<VoiceFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // Not created yet — the pre-install state, not an error.
  }
  const out: VoiceFile[] = [];
  for (const file of entries) {
    if (!file.toLowerCase().endsWith('.wav')) continue;
    const p = path.join(dir, file);
    try {
      const s = await stat(p);
      if (!s.isFile()) continue;
      out.push({ file, dir, path: p, legacy, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // Raced with a delete between readdir and stat — just skip it.
    }
  }
  return out;
}

// readdir + stat only. This is what GET /settings hits on every admin poll —
// keep it subprocess-free. Canonical dir wins on a filename clash, matching
// chatterbox.resolveReferenceWav()'s resolution order.
export async function scan(): Promise<VoiceFile[]> {
  const [primary, legacy] = await Promise.all([
    scanDir(config.voices.dir, false),
    scanDir(config.voices.legacyDir, true),
  ]);
  const seen = new Set<string>();
  const merged: VoiceFile[] = [];
  for (const e of [...primary, ...legacy]) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    merged.push(e);
  }
  return merged.sort((a, b) => a.file.localeCompare(b.file));
}

// Memo key for a probed duration. Size AND mtime, so replacing a file in place
// (re-upload, or a hand-copy over FTP) re-probes rather than showing a stale
// length forever.
export function durationMemoKey(entry: VoiceFile): string {
  return `${entry.path}:${entry.size}:${entry.mtimeMs}`;
}

const durationMemo = new Map<string, number | null>();
// Bounded so a long-lived controller re-uploading the same names can't grow it
// without limit. The folder is a handful of files; a full clear is cheap.
const MEMO_MAX = 200;

async function durationOf(entry: VoiceFile): Promise<number | null> {
  const key = durationMemoKey(entry);
  const hit = durationMemo.get(key);
  if (hit !== undefined) return hit;
  const measured = await probeDurationSec(entry.path);
  if (durationMemo.size >= MEMO_MAX) durationMemo.clear();
  durationMemo.set(key, measured);
  return measured;
}

// scan() plus measured durations. Admin-facing only — never call this from the
// /settings listing path.
export async function list(): Promise<VoiceEntry[]> {
  const files = await scan();
  const out: VoiceEntry[] = [];
  for (const e of files) {
    const durationSec = await durationOf(e);
    out.push({
      file: e.file,
      size: e.size,
      legacy: e.legacy,
      durationSec,
      warning: voiceWarning(durationSec),
    });
  }
  return out;
}

// Look up a caller-supplied filename. NEVER builds a path from the input: it
// basenames, rejects anything that changed under basename (a separator or a
// traversal segment), then requires the name to be present in the real scan.
// Both admin :file routes go through here.
export async function resolve(file: string): Promise<VoiceFile | null> {
  const raw = String(file || '');
  if (!raw) return null;
  if (path.basename(raw) !== raw) return null;
  const files = await scan();
  return files.find(e => e.file === raw) || null;
}

// Import an operator-supplied clip as a reference voice. Transcoded to the
// canonical mono 24 kHz WAV — which also validates the upload, since ffmpeg
// exits non-zero on anything that isn't decodable audio.
//
// Note the divergence from sfx.importAudio's no-ffmpeg fallback: storing raw
// bytes under the original extension is NOT safe here, because the .wav
// extension is load-bearing twice over (scan() filters on it; the workers need
// real WAV bytes). Without ffmpeg we take a .wav through untouched and refuse
// anything else with a message naming the missing tool. Every Docker image
// ships ffmpeg, so this only bites `npm start` on a bare host.
export async function importVoice(
  buffer: Buffer,
  { name, originalName = '' }: { name: string; originalName?: string },
): Promise<VoiceEntry> {
  const file = voiceFileName(name);
  if (!buffer?.length) throw new Error('Empty audio file');
  if (originalName && !isAcceptedAudio(originalName)) {
    throw new Error(`Unsupported audio type: ${originalName}`);
  }
  // Refuse a clash rather than clobber: the filename IS the reference every
  // persona holds, so overwriting would silently swap a persona's voice.
  if (await resolve(file)) {
    throw new Error(`a voice named "${file}" already exists — delete it first`);
  }

  const dir = config.voices.dir;
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, file);

  if (await hasFfmpeg()) {
    await transcodeAudio(buffer, {
      outPath,
      format: 'wav',
      sampleRate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS,
    });
  } else if (extOf(originalName) === 'wav') {
    await writeFile(outPath, buffer);
  } else {
    throw new Error(
      'ffmpeg is not installed on this host, so only .wav uploads can be accepted'
      + ' — convert the file first, or run the Docker image (it ships ffmpeg)',
    );
  }

  // Length is advisory: measure it, report it, never act on it.
  const durationSec = await probeDurationSec(outPath);
  const s = await stat(outPath);
  return {
    file,
    size: s.size,
    legacy: false,
    durationSec,
    warning: voiceWarning(durationSec),
  };
}

// Delete by filename, from whichever dir it actually lives in — so a
// legacy-folder voice is manageable from the UI too.
export async function removeVoice(file: string): Promise<{ ok: true; file: string }> {
  const entry = await resolve(file);
  if (!entry) throw new Error(`unknown voice: ${file}`);
  await unlink(entry.path);
  return { ok: true, file: entry.file };
}

/**
 * Store an already-canonical reference WAV under a name that is FREE.
 *
 * The bundle-import counterpart of importVoice (#1620), and it diverges on both
 * of that function's decisions for the same reason: the bytes came out of
 * another station's copy of this very folder, so they are already mono 24 kHz
 * WAV and re-transcoding them would need ffmpeg to import a file that never
 * needed converting; and a clash cannot be REFUSED here, because the operator
 * has no way to rename a member inside a zip they were handed. So it suffixes
 * (`morgan.wav` → `morgan-2.wav`) and returns the name it actually used — which
 * the caller must then write onto the incoming persona's `tts.voice`, since
 * that field is the only thing tying a persona to a file in here.
 *
 * Never overwrites: the scan it checks against covers the legacy folder too, so
 * a name that only exists there still counts as taken.
 */
export async function adoptVoice(
  buffer: Buffer,
  { file }: { file: string },
): Promise<VoiceEntry> {
  if (!buffer?.length) throw new Error('Empty audio file');
  const wanted = path.basename(String(file || ''));
  if (!wanted || wanted !== String(file || '') || extOf(wanted) !== 'wav') {
    throw new Error(`not a reference voice filename: ${file}`);
  }
  const existing = await scan();
  const name = uniqueFilename(wanted, existing.map(e => e.file));

  const dir = config.voices.dir;
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, name);
  await writeFile(outPath, buffer);

  const durationSec = await probeDurationSec(outPath);
  const s = await stat(outPath);
  return { file: name, size: s.size, legacy: false, durationSec, warning: voiceWarning(durationSec) };
}
