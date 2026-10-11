// Reference voices live in state/voices and legacy state/chatterbox-voices (#213).
// The /settings poll uses scan(), which never spawns subprocesses; list() probes durations.
// Cache durations by size+mtime so hand-added or replaced files remain visible.

import { readdir, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { slugify } from '../util/slug.js';
import { uniqueFilename } from '../personas/bundle-pure.js';
import { TTS_CHATTERBOX_VOICE_RE } from '../schemas/persona.js';
import {
  transcodeAudio, hasFfmpeg, extOf, baseName, isAcceptedAudio, probeDurationSec,
} from './audio-import.js';

// Reference length advice never truncates or rejects a clip.
export const ADVISORY_MIN_SEC = 4;
export const ADVISORY_MAX_SEC = 20;

// Both workers resample internally; mono 24 kHz is the common stored format.
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

// Strip typed extensions before adding .wav; scans and workers require real WAV files.
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

// The /settings poll must stay subprocess-free; canonical files beat legacy name clashes.
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

// Reprobe when size or mtime changes, including in-place replacements.
export function durationMemoKey(entry: VoiceFile): string {
  return `${entry.path}:${entry.size}:${entry.mtimeMs}`;
}

const durationMemo = new Map<string, number | null>();
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

// Only list() probes durations; never call it from the /settings poll.
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

// Reject basename changes, then require membership in the actual scan before opening files.
export async function resolve(file: string): Promise<VoiceFile | null> {
  const raw = String(file || '');
  if (!raw) return null;
  if (path.basename(raw) !== raw) return null;
  const files = await scan();
  return files.find(e => e.file === raw) || null;
}

// Validate/transcode uploads to mono 24 kHz WAV. Without ffmpeg, accept only WAV;
// a renamed non-WAV would pass the filename scan but fail the cloning workers.
export async function importVoice(
  buffer: Buffer,
  { name, originalName = '' }: { name: string; originalName?: string },
): Promise<VoiceEntry> {
  const file = voiceFileName(name);
  if (!buffer?.length) throw new Error('Empty audio file');
  if (originalName && !isAcceptedAudio(originalName)) {
    throw new Error(`Unsupported audio type: ${originalName}`);
  }
  // A persona stores this filename; overwriting would silently change its voice.
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
