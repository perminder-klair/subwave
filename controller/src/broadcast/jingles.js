// Jingles — pre-recorded TTS stingers that rotate into the broadcast at
// 1-per-30-track intervals (see liquidsoap/radio.liq).
//
// Files live at <stateDir>/jingles/<hash>.wav and are referenced from
// <stateDir>/jingles.m3u (one path per line). A sidecar <stateDir>/
// jingles.json maps filename → { text, createdAt, builtin }.

import { readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { speak } from '../audio/tts.js';
import { STATE_DIR } from '../config.js';

const DIR = `${STATE_DIR}/jingles`;
const PLAYLIST = `${STATE_DIR}/jingles.m3u`;
const META = `${STATE_DIR}/jingles.json`;

const DEFAULT_IDENT = {
  filename: 'station_ident_default.wav',
  text: "You're listening to SUB/WAVE. Personal frequency, broadcasting from the homelab.",
  builtin: true,
};

async function loadMeta() {
  try {
    return JSON.parse(await readFile(META, 'utf8'));
  } catch {
    return { items: {} };
  }
}

async function saveMeta(meta) {
  await writeFile(META, JSON.stringify(meta, null, 2));
}

async function rewritePlaylist(filenames) {
  const lines = filenames.map(f => `${DIR}/${f}`);
  await writeFile(PLAYLIST, lines.join('\n') + (lines.length ? '\n' : ''));
}

async function statOrNull(p) {
  try { return await stat(p); } catch { return null; }
}

// Returns the listed jingles with file existence verified
export async function list() {
  const meta = await loadMeta();
  const out = [];
  for (const [filename, info] of Object.entries(meta.items)) {
    const filePath = `${DIR}/${filename}`;
    const s = await statOrNull(filePath);
    if (!s) continue;
    out.push({
      filename,
      text: info.text,
      createdAt: info.createdAt,
      builtin: !!info.builtin,
      size: s.size,
    });
  }
  // Newest first, but builtin always last so user-created appear on top
  out.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  return out;
}

export async function create(text, { builtin = false } = {}) {
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

export async function remove(filename) {
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

// Called from server.js startup. Generates the default station ident WAV
// if it isn't already on disk. Idempotent — running again does nothing.
export async function ensureDefaultIdent() {
  const filePath = `${DIR}/${DEFAULT_IDENT.filename}`;
  const meta = await loadMeta();

  if (existsSync(filePath) && meta.items[DEFAULT_IDENT.filename]) return;

  await create(DEFAULT_IDENT.text, { builtin: true });
  console.log(`[jingles] generated default station ident → ${filePath}`);
}
