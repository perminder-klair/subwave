// The shared voice-clone reference folder: state/voices/ plus the legacy
// pre-#213 state/chatterbox-voices/. Chatterbox and PocketTTS clone from the
// WAVs here (a persona's `tts.voice` is one of these filenames) and custom Piper
// .onnx voices live alongside them.
//
// SINGLE scanner of those directories. Two entry points on purpose: GET
// /settings hits the listing path on every 3s admin poll, so scan() stays
// readdir+stat and never spawns a subprocess; only list() probes durations.
//
// No JSON sidecar (unlike broadcast/sfx.ts): the folder is operator-writable by
// hand, and a sidecar would carry no entry for a hand-dropped file. Durations
// are memoised on size+mtime instead.

import { readdir, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { slugify } from '../util/slug.js';
import { uniqueFilename } from '../personas/bundle-pure.js';
import { TTS_CHATTERBOX_VOICE_RE } from '../schemas/persona.js';
import {
  transcodeAudio, hasFfmpeg, extOf, baseName, isAcceptedAudio, probeDurationSec,
} from './audio-import.js';

// Advisory band for a reference clip: too short may not clone stably, too long
// only slows every render. Advisory ONLY, nothing truncates or refuses on it.
export const ADVISORY_MIN_SEC = 4;
export const ADVISORY_MAX_SEC = 20;

// Canonical stored form. Both workers resample internally, so mono 24 kHz is a
// safe common denominator that keeps files small.
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

// Pure. An unknown duration (no ffprobe) is "no advice", never "bad".
export function voiceWarning(durationSec: number | null | undefined): VoiceWarning {
  if (durationSec == null || !Number.isFinite(durationSec)) return null;
  if (durationSec < ADVISORY_MIN_SEC) return 'short';
  if (durationSec > ADVISORY_MAX_SEC) return 'long';
  return null;
}

// The on-disk filename for an operator-supplied name. Always `.wav`: scan()
// filters on it and the workers need real WAV bytes. A typed audio extension is
// stripped first so "morgan.wav" doesn't become "morgan-wav.wav".
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
    return []; // Not created yet: the pre-install state, not an error.
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

// readdir + stat only: GET /settings hits this on every admin poll, so keep it
// subprocess-free. Canonical dir wins on a filename clash, matching
// chatterbox.resolveReferenceWav().
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

// Memo key: size AND mtime, so replacing a file in place re-probes rather than
// showing a stale length forever.
export function durationMemoKey(entry: VoiceFile): string {
  return `${entry.path}:${entry.size}:${entry.mtimeMs}`;
}

const durationMemo = new Map<string, number | null>();
// Bounded so a long-lived controller can't grow it without limit; a full clear
// is cheap on a folder this size.
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

// scan() plus measured durations. Admin-facing only: never call this from the
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

// Look up a caller-supplied filename. Never builds a path from the input: it
// basenames, rejects anything that changed under basename, then requires the
// name to be in the real scan. Both admin :file routes go through here.
export async function resolve(file: string): Promise<VoiceFile | null> {
  const raw = String(file || '');
  if (!raw) return null;
  if (path.basename(raw) !== raw) return null;
  const files = await scan();
  return files.find(e => e.file === raw) || null;
}

// Import an operator-supplied clip as a reference voice, transcoded to the
// canonical mono 24 kHz WAV, which also validates the upload (ffmpeg exits
// non-zero on undecodable audio). Unlike sfx.importAudio there is no raw-bytes
// fallback: the .wav extension is load-bearing twice (scan() filters on it, the
// workers need real WAV bytes), so without ffmpeg a .wav passes through and
// anything else is refused.
export async function importVoice(
  buffer: Buffer,
  { name, originalName = '' }: { name: string; originalName?: string },
): Promise<VoiceEntry> {
  const file = voiceFileName(name);
  if (!buffer?.length) throw new Error('Empty audio file');
  if (originalName && !isAcceptedAudio(originalName)) {
    throw new Error(`Unsupported audio type: ${originalName}`);
  }
  // Refuse a clash rather than clobber: the filename IS the reference a persona
  // holds, so overwriting would silently swap its voice.
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

// Delete by filename from whichever dir it lives in, so a legacy-folder voice is
// manageable from the UI too.
export async function removeVoice(file: string): Promise<{ ok: true; file: string }> {
  const entry = await resolve(file);
  if (!entry) throw new Error(`unknown voice: ${file}`);
  await unlink(entry.path);
  return { ok: true, file: entry.file };
}

/**
 * Is `file` a name adoptVoice() will accept? Pure enough to ask before writing.
 *
 * TTS_CHATTERBOX_VOICE_RE rather than a local ".wav" test, because this name is
 * written onto the incoming persona's `tts.voice` and that field is validated
 * by exactly that regex on save. A name this accepts but the schema refuses is
 * a file on disk followed by a 400 — which is how the import came to leave
 * litter behind a refusal.
 */
export function isAdoptableVoiceName(file: unknown): boolean {
  const raw = String(file ?? '');
  const wanted = path.basename(raw);
  if (!wanted || wanted !== raw) return false;
  return TTS_CHATTERBOX_VOICE_RE.test(wanted);
}

/**
 * The name adoptVoice() WOULD use for `file`, without writing anything.
 *
 * Split out so an importer can settle the filename, put it on the persona and
 * validate the whole roster BEFORE the first byte lands — a refusal after the
 * write leaves a sample nobody points at. Reserving is not locking; see
 * jingles.reserveNames.
 */
export async function reserveVoiceName(file: string): Promise<string> {
  if (!isAdoptableVoiceName(file)) {
    throw new Error(`not a reference voice filename: ${file}`);
  }
  const existing = await scan();
  return uniqueFilename(path.basename(String(file)), existing.map(e => e.file));
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
 * a name that only exists there still counts as taken. `reserved` is the name
 * reserveVoiceName() already returned for this member; omitting it reserves one
 * here, so a lone caller is still safe.
 */
export async function adoptVoice(
  buffer: Buffer,
  { file, reserved = '' }: { file: string; reserved?: string },
): Promise<VoiceEntry> {
  if (!buffer?.length) throw new Error('Empty audio file');
  if (!isAdoptableVoiceName(file)) {
    throw new Error(`not a reference voice filename: ${file}`);
  }
  const name = reserved || await reserveVoiceName(file);
  // The reservation is the name the persona's `tts.voice` will hold, so it
  // answers to the schema that field is saved under, not merely to ".wav".
  if (!TTS_CHATTERBOX_VOICE_RE.test(name)) {
    throw new Error(`not a reference voice filename: ${name}`);
  }

  const dir = config.voices.dir;
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, name);
  await writeFile(outPath, buffer);

  const durationSec = await probeDurationSec(outPath);
  const s = await stat(outPath);
  return { file: name, size: s.size, legacy: false, durationSec, warning: voiceWarning(durationSec) };
}
