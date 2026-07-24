// Jingles — pre-recorded TTS stingers that rotate into the broadcast at
// 1-per-30-track intervals (see liquidsoap/radio.liq).
//
// Files live at <stateDir>/jingles/<hash>.wav and are referenced from
// <stateDir>/jingles.m3u (one path per line). A sidecar <stateDir>/
// jingles.json maps filename → { text, createdAt, builtin, source }.

import { readFile, writeFile, unlink, mkdir, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { speak } from '../audio/tts.js';
import { STATE_DIR, SOUNDS_DIR } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import {
  transcodeAudio, hasFfmpeg, extOf, baseName, isAcceptedAudio,
} from '../audio/audio-import.js';

const DIR = `${STATE_DIR}/jingles`;
const PLAYLIST = `${STATE_DIR}/jingles.m3u`;
const META = `${STATE_DIR}/jingles.json`;

const DEFAULT_IDENT = {
  filename: 'station_ident_default.wav',
  text: "You're tuned to SUB/WAVE. The signal continues.",
  builtin: true,
};

// Repo-bundled, sound-designed version of the default ident (voice over a
// radio-tuning/static bed). Shipped in <repo>/sounds and installed verbatim at
// boot so every install gets the same signature stinger regardless of the
// operator's TTS engine. Falls back to a plain TTS render if it's ever absent.
const PREBAKED_IDENT = `${SOUNDS_DIR}/station_ident_default.wav`;

async function loadMeta(): Promise<any> {
  try {
    return JSON.parse(await readFile(META, 'utf8'));
  } catch {
    return { items: {} };
  }
}

async function saveMeta(meta: any) {
  await writeFileAtomic(META, JSON.stringify(meta, null, 2));
}

// Atomic replace: Liquidsoap watches jingles.m3u (reload_mode="watch"), so an
// in-place rewrite can reload a truncated playlist mid-write.
async function rewritePlaylist(filenames: string[]) {
  const lines = filenames.map((f: string) => `${DIR}/${f}`);
  await writeFileAtomic(PLAYLIST, lines.join('\n') + (lines.length ? '\n' : ''));
}

async function statOrNull(p: string) {
  try { return await stat(p); } catch { return null; }
}

// Returns the listed jingles with file existence verified
export async function list() {
  const meta = await loadMeta();
  const out: any[] = [];
  for (const [filename, info] of Object.entries(meta.items) as [string, any][]) {
    const filePath = `${DIR}/${filename}`;
    const s = await statOrNull(filePath);
    if (!s) continue;
    out.push({
      filename,
      text: info.text,
      createdAt: info.createdAt,
      builtin: !!info.builtin,
      source: info.source || (info.builtin ? 'builtin' : 'tts'),
      size: s.size,
    });
  }
  // Newest first, but builtin always last so user-created appear on top
  out.sort((a: any, b: any) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  return out;
}

// Absolute path to a jingle's audio file, or null if the filename isn't in
// the sidecar or the file is missing on disk. Looking it up via the sidecar
// (instead of joining DIR + the raw param) is what makes path traversal a
// non-issue — `..` slugs simply won't match a key.
export async function getPath(filename: string): Promise<string | null> {
  const meta = await loadMeta();
  if (!meta.items[filename]) return null;
  const filePath = `${DIR}/${filename}`;
  return (await statOrNull(filePath)) ? filePath : null;
}

export async function create(text: string, { builtin = false }: { builtin?: boolean } = {}) {
  if (!text || !text.trim()) throw new Error('Empty jingle text');
  await mkdir(DIR, { recursive: true });

  const id = crypto.randomBytes(4).toString('hex');
  const filename = builtin ? DEFAULT_IDENT.filename : `jingle_${id}.wav`;
  const outPath = `${DIR}/${filename}`;

  await speak(text, { kind: 'jingle', outPath });

  const meta = await loadMeta();
  meta.items[filename] = {
    text: text.trim(),
    createdAt: new Date().toISOString(),
    builtin,
  };
  await saveMeta(meta);
  await rewritePlaylist(Object.keys(meta.items));
  return { filename, text: text.trim(), outPath };
}

// Import an operator-supplied audio file as a jingle. The upload is transcoded
// to WAV + loudness-levelled (matching generated jingles) when ffmpeg is
// available, otherwise stored as-is with its original extension. `label` is the
// display text; it defaults to the original file name. Returns { filename, text }.
export async function importAudio(
  buffer: Buffer,
  { label = '', originalName = '' }: { label?: string; originalName?: string } = {},
) {
  if (!buffer?.length) throw new Error('Empty audio file');
  if (originalName && !isAcceptedAudio(originalName)) {
    throw new Error(`Unsupported audio type: ${originalName}`);
  }
  await mkdir(DIR, { recursive: true });

  const id = crypto.randomBytes(4).toString('hex');
  let filename: string;
  if (await hasFfmpeg()) {
    filename = `jingle_${id}.wav`;
    await transcodeAudio(buffer, { outPath: `${DIR}/${filename}`, format: 'wav', loudnorm: true });
  } else {
    filename = `jingle_${id}.${extOf(originalName) || 'mp3'}`;
    await writeFile(`${DIR}/${filename}`, buffer);
  }

  const text = (label || '').trim() || baseName(originalName) || 'Imported jingle';
  const meta = await loadMeta();
  meta.items[filename] = {
    text,
    createdAt: new Date().toISOString(),
    builtin: false,
    source: 'upload',
  };
  await saveMeta(meta);
  await rewritePlaylist(Object.keys(meta.items));
  return { filename, text };
}

export async function remove(filename: string) {
  // Prevent deleting the default ident — they can recreate it but not delete
  const meta = await loadMeta();
  if (!meta.items[filename]) throw new Error(`unknown jingle: ${filename}`);
  if (meta.items[filename].builtin) {
    throw new Error('cannot delete builtin station ident');
  }

  try { await unlink(`${DIR}/${filename}`); } catch {}
  delete meta.items[filename];
  await saveMeta(meta);
  await rewritePlaylist(Object.keys(meta.items));
  return { ok: true };
}

// Called from server.js startup. Installs the default station ident if it isn't
// already present. Prefers the repo-bundled sound-designed WAV (PREBAKED_IDENT);
// if that's missing, falls back to a plain TTS render. Idempotent, and upgrades
// an older TTS-rendered builtin to the bundled asset exactly once (keyed on
// `source: 'builtin'`).
export async function ensureDefaultIdent() {
  const filePath = `${DIR}/${DEFAULT_IDENT.filename}`;
  const meta = await loadMeta();
  const existing = meta.items[DEFAULT_IDENT.filename];
  const havePrebaked = existsSync(PREBAKED_IDENT);

  // Already the bundled asset — or an existing render with no asset to upgrade to.
  if (existsSync(filePath) && existing && (existing.source === 'builtin' || !havePrebaked)) {
    // Rewrite the playlist anyway: its entries are ABSOLUTE paths under the
    // active station dir, and a multi-station conversion (or duplicate) moves
    // or copies the m3u without touching its contents — re-deriving it at
    // every boot is what keeps jingles airing after the dir changes identity.
    await rewritePlaylist(Object.keys(meta.items));
    return;
  }

  if (havePrebaked) {
    await mkdir(DIR, { recursive: true });
    await copyFile(PREBAKED_IDENT, filePath);
    meta.items[DEFAULT_IDENT.filename] = {
      text: DEFAULT_IDENT.text,
      createdAt: existing?.createdAt || new Date().toISOString(),
      builtin: true,
      source: 'builtin',
    };
    await saveMeta(meta);
    await rewritePlaylist(Object.keys(meta.items));
    console.log(`[jingles] installed default station ident from ${PREBAKED_IDENT}`);
    return;
  }

  await create(DEFAULT_IDENT.text, { builtin: true });
  console.log(`[jingles] generated default station ident → ${filePath}`);
}
