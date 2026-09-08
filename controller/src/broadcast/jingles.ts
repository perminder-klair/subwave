// Jingle store: WAVs under <stateDir>/jingles/, absolute paths listed one per
// line in <stateDir>/jingles.m3u, metadata in the <stateDir>/jingles.json
// sidecar (filename → { text, createdAt, builtin, source }).

import { readFile, readdir, writeFile, unlink, mkdir, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { basename as pathBasename } from 'node:path';
import { speak } from '../audio/tts.js';
import { STATE_DIR, SOUNDS_DIR } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import {
  transcodeAudio, hasFfmpeg, extOf, baseName, isAcceptedAudio,
} from '../audio/audio-import.js';
import { JINGLE_FILENAME_RE, JINGLE_NAME_MAX, uniqueFilename } from '../personas/bundle-pure.js';

const DIR = `${STATE_DIR}/jingles`;
const PLAYLIST = `${STATE_DIR}/jingles.m3u`;
const META = `${STATE_DIR}/jingles.json`;

const DEFAULT_IDENT = {
  filename: 'station_ident_default.wav',
  text: "You're tuned to SUB/WAVE. The signal continues.",
  builtin: true,
};

// Repo-bundled default ident, installed verbatim at boot so every install gets
// the same stinger whatever its TTS engine. Falls back to a TTS render if absent.
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

// Atomic: Liquidsoap watches jingles.m3u (reload_mode="watch"), so an in-place
// rewrite can reload a truncated playlist mid-write.
async function rewritePlaylist(filenames: string[]) {
  const lines = filenames.map((f: string) => `${DIR}/${f}`);
  await writeFileAtomic(PLAYLIST, lines.join('\n') + (lines.length ? '\n' : ''));
}

async function statOrNull(p: string) {
  try { return await stat(p); } catch { return null; }
}

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
  out.sort((a: any, b: any) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  return out;
}

// Resolving through the sidecar keys rather than joining DIR + the raw param is
// what makes path traversal a non-issue: `..` slugs match no key.
export async function getPath(filename: string): Promise<string | null> {
  const meta = await loadMeta();
  if (!meta.items[filename]) return null;
  const filePath = `${DIR}/${filename}`;
  return (await statOrNull(filePath)) ? filePath : null;
}

// annotate: URI for a one-off airing via the priority jingle_now_queue
// (queue.playJingle), not the automatic rotate. That queue sits outside
// music_meta, so retained ID3 tags never reach now-playing or ICY. No
// cue_out/cross overrides unlike beds.bedUri: a jingle plays in full.
export function jingleUri(path: string): string {
  return `annotate:subwave_kind="jingle":${path}`;
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

// Import an operator-supplied audio file. Transcoded to WAV + loudness-levelled
// when ffmpeg is available, otherwise stored as-is with its original extension.
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

// Called from server.js startup. Idempotent; upgrades an older TTS-rendered
// builtin to the bundled asset exactly once (keyed on `source: 'builtin'`).
export async function ensureDefaultIdent() {
  const filePath = `${DIR}/${DEFAULT_IDENT.filename}`;
  const meta = await loadMeta();
  const existing = meta.items[DEFAULT_IDENT.filename];
  const havePrebaked = existsSync(PREBAKED_IDENT);

  // Already the bundled asset, or a render with no asset to upgrade to.
  if (existsSync(filePath) && existing && (existing.source === 'builtin' || !havePrebaked)) {
    // Rewrite the playlist anyway: entries are absolute paths under the active
    // station dir, and a multi-station move/copy leaves stale ones behind.
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

/**
 * Is `filename` something adopt() will accept? Pure, so a caller can ask BEFORE
 * it has written anything (personas/bundle.ts asks for every member up front).
 *
 * The character-class half is the one that matters. A filename here becomes a
 * LINE of jingles.m3u, which Liquidsoap reloads on watch, so a newline in a
 * name adds a rotation entry nobody chose — see JINGLE_FILENAME_RE. An
 * extension test alone leaves the rest of the name unchecked.
 */
export function isAdoptableName(filename: unknown): boolean {
  const raw = String(filename ?? '');
  const wanted = pathBasename(raw);
  if (!wanted || wanted !== raw) return false;
  return JINGLE_FILENAME_RE.test(wanted) && isAcceptedAudio(wanted);
}

/**
 * The names `adopt()` WOULD use for `desired`, without writing anything.
 *
 * Split out from adopt so an importer can settle every filename before its
 * first write and refuse cleanly if any of them is unusable — a refusal after
 * the first write leaves a stinger in the rotation for a DJ that was never
 * created. Reservations accumulate across the batch: two members that both
 * suffix onto the same free name must not both be handed it.
 *
 * Reserving is not locking. The caller has to write what it reserved without
 * awaiting another adopt in between; personas/bundle.ts serialises whole
 * imports for exactly that reason.
 */
export async function reserveNames(desired: readonly string[]): Promise<string[]> {
  const meta = await loadMeta();
  const onDisk = await readdir(DIR).catch(() => [] as string[]);
  const taken = new Set<string>([...Object.keys(meta.items), ...onDisk]);
  const out: string[] = [];
  for (const d of desired) {
    if (!isAdoptableName(d)) throw new Error(`Unsupported audio filename: ${d}`);
    const name = uniqueFilename(pathBasename(String(d)), taken, JINGLE_NAME_MAX);
    taken.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Adopt a jingle that arrived inside a persona bundle (#1620), keeping the
 * filename it had on the station that exported it.
 *
 * Distinct from importAudio, which mints `jingle_<hex>.wav` and transcodes: a
 * bundled jingle is already a rendered stinger from another copy of this very
 * folder, so it is stored verbatim (an import must not need ffmpeg) under its
 * own name — which is what makes re-importing the same bundle legible rather
 * than filling the folder with anonymous hashes. A name already in use gets a
 * `-2` suffix and NEVER an overwrite: the sidecar key is the only handle the
 * playlist, the delete route and the audition route have on a file.
 *
 * `reserved` is the name reserveNames() already handed back for this member.
 * Passing it is what lets an importer settle every name before its first write;
 * omitting it reserves one here, so a lone caller is still safe. Either way the
 * name is re-checked against the same predicate before it reaches disk.
 *
 * Still the same single writer of jingles.json + jingles.m3u as every other
 * path in here.
 */
export async function adopt(
  buffer: Buffer,
  { filename, text = '', reserved = '' }: { filename: string; text?: string; reserved?: string },
) {
  if (!buffer?.length) throw new Error('Empty audio file');
  if (!isAdoptableName(filename)) {
    throw new Error(`Unsupported audio filename: ${filename}`);
  }
  const wanted = pathBasename(String(filename));
  await mkdir(DIR, { recursive: true });
  const meta = await loadMeta();
  // The sidecar AND the directory: a file on disk with no sidecar entry is
  // invisible to list() but is still a file, and "never overwrite" has to mean
  // never, not "never one we have a record of".
  const onDisk = await readdir(DIR).catch(() => [] as string[]);
  const name = reserved || uniqueFilename(
    wanted, [...Object.keys(meta.items), ...onDisk], JINGLE_NAME_MAX,
  );
  // A reservation is still a filename, and it is the one that reaches the
  // playlist — so it answers to the same rule the desired name did.
  if (!isAdoptableName(name)) throw new Error(`Unsupported audio filename: ${name}`);
  await writeFile(`${DIR}/${name}`, buffer);
  meta.items[name] = {
    text: String(text || '').trim() || baseName(wanted) || 'Imported jingle',
    createdAt: new Date().toISOString(),
    builtin: false,
    source: 'upload',
  };
  await saveMeta(meta);
  await rewritePlaylist(Object.keys(meta.items));
  return { filename: name, text: meta.items[name].text };
}
