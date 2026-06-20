// Sound-effects library — short pre-rendered stingers the segment-director
// agent (skills/_agent.js) can play UNDERNEATH its voice via the sfx_queue in
// liquidsoap/radio.liq.
//
// Mirrors broadcast/jingles.js: audio files on disk plus a JSON sidecar, with
// admin CRUD on top. Files live at <stateDir>/sfx/<name>.mp3; the sidecar
// <stateDir>/sfx.json maps name → { name, description, prompt, durationSec,
// file, builtin, createdAt }. Unlike jingles there is no .m3u — Liquidsoap
// plays an effect on demand (controller writes its path to sfx.txt), it does
// not rotate them on a playlist.

import { readFile, writeFile, unlink, mkdir, stat, copyFile } from 'node:fs/promises';
import { STATE_DIR, SOUNDS_DIR } from '../config.js';
import { generateSfx, isConfigured } from '../audio/sfx-gen.js';
import { transcodeAudio, hasFfmpeg, extOf, isAcceptedAudio } from '../audio/audio-import.js';

const DIR = `${STATE_DIR}/sfx`;
const META = `${STATE_DIR}/sfx.json`;
// Repo-bundled default effects, rendered once and committed (sounds/sfx/).
// ensureDefaults() copies these in so a fresh boot needs no ElevenLabs key.
const BUNDLE_DIR = `${SOUNDS_DIR}/sfx`;

// Built-in starter set — rendered on first boot when ElevenLabs is configured.
const DEFAULT_SFX = [
  {
    name: 'record-scratch',
    description: 'abrupt vinyl record scratch — punctuates a hard cut, a joke, or a sudden change of subject',
    prompt: 'abrupt vinyl record scratch, short and sharp',
    durationSec: 1.5,
  },
  {
    name: 'airhorn',
    description: 'a single short airhorn blast — celebratory; use very sparingly, only for a genuinely big moment',
    prompt: 'single short reggae airhorn blast',
    durationSec: 1.5,
  },
  {
    name: 'applause',
    description: 'a brief burst of crowd applause — for a triumphant or warm beat',
    prompt: 'short warm crowd applause burst',
    durationSec: 2.5,
  },
  {
    name: 'whoosh',
    description: 'a quick transitional whoosh — smooths a scene change or a fast aside',
    prompt: 'quick cinematic transition whoosh',
    durationSec: 1.2,
  },
  {
    name: 'drum-roll',
    description: 'a short drum roll — builds anticipation before a reveal',
    prompt: 'short snare drum roll ending on a cymbal hit',
    durationSec: 2.5,
  },
  {
    name: 'vinyl-stop',
    description: 'a turntable power-down — a dramatic dead stop on a thought',
    prompt: 'turntable power down, vinyl record slowing to a stop',
    durationSec: 1.8,
  },
];

function slugify(name: string) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function loadMeta(): Promise<any> {
  try {
    return JSON.parse(await readFile(META, 'utf8'));
  } catch {
    return { items: {} };
  }
}

async function saveMeta(meta: any) {
  await writeFile(META, JSON.stringify(meta, null, 2));
}

async function statOrNull(p: string) {
  try { return await stat(p); } catch { return null; }
}

// Returns the listed effects with file existence verified.
export async function list() {
  const meta = await loadMeta();
  const out: any[] = [];
  for (const [name, info] of Object.entries(meta.items) as [string, any][]) {
    const s = await statOrNull(`${DIR}/${info.file}`);
    if (!s) continue;
    out.push({
      name,
      description: info.description || '',
      prompt: info.prompt || '',
      durationSec: info.durationSec || null,
      builtin: !!info.builtin,
      source: info.source || (info.builtin ? 'builtin' : 'generated'),
      createdAt: info.createdAt,
      size: s.size,
    });
  }
  // Built-ins last so operator-created effects appear on top.
  out.sort((a: any, b: any) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return (a.name || '').localeCompare(b.name || '');
  });
  return out;
}

// Name + description only — the slim view the segment agent reads to decide
// whether (and which) effect fits a line.
export async function catalog() {
  return (await list()).map((s: any) => ({ name: s.name, description: s.description }));
}

// Absolute path to an effect's audio file, or null if unknown / missing.
export async function getPath(name: string) {
  const meta = await loadMeta();
  const info = meta.items[name];
  if (!info) return null;
  const filePath = `${DIR}/${info.file}`;
  return (await statOrNull(filePath)) ? filePath : null;
}

export async function create({ name, description, prompt, durationSec, builtin = false }: any = {}) {
  const slug = slugify(name);
  if (!slug) throw new Error('Sound effect name is required');
  if (!prompt || !prompt.trim()) throw new Error('Sound effect prompt is required');
  await mkdir(DIR, { recursive: true });

  const file = `${slug}.mp3`;
  await generateSfx(prompt, { durationSec, outPath: `${DIR}/${file}` });

  const meta = await loadMeta();
  meta.items[slug] = {
    name: slug,
    description: (description || '').trim(),
    prompt: prompt.trim(),
    durationSec: Number(durationSec) || null,
    file,
    builtin,
    createdAt: new Date().toISOString(),
  };
  await saveMeta(meta);
  return meta.items[slug];
}

// Import an operator-supplied audio file as a sound effect. Transcoded to MP3
// (matching generated effects) when ffmpeg is available, otherwise stored as-is
// with its original extension. No loudnorm — effects are short and a one-pass
// loudness pass on a transient is unreliable; the broadcast limiter catches
// peaks. Rejects a name that already exists so a built-in can't be clobbered.
export async function importAudio(
  buffer: Buffer,
  { name, description = '', originalName = '' }: { name: string; description?: string; originalName?: string },
) {
  const slug = slugify(name);
  if (!slug) throw new Error('Sound effect name is required');
  if (!buffer?.length) throw new Error('Empty audio file');
  if (originalName && !isAcceptedAudio(originalName)) {
    throw new Error(`Unsupported audio type: ${originalName}`);
  }
  await mkdir(DIR, { recursive: true });

  const meta = await loadMeta();
  if (meta.items[slug]) throw new Error(`a sound effect named "${slug}" already exists`);

  let file: string;
  if (await hasFfmpeg()) {
    file = `${slug}.mp3`;
    await transcodeAudio(buffer, { outPath: `${DIR}/${file}`, format: 'mp3' });
  } else {
    file = `${slug}.${extOf(originalName) || 'mp3'}`;
    await writeFile(`${DIR}/${file}`, buffer);
  }

  meta.items[slug] = {
    name: slug,
    description: (description || '').trim(),
    prompt: '',
    durationSec: null,
    file,
    builtin: false,
    source: 'upload',
    createdAt: new Date().toISOString(),
  };
  await saveMeta(meta);
  return meta.items[slug];
}

export async function remove(name) {
  const meta = await loadMeta();
  const info = meta.items[name];
  if (!info) throw new Error(`unknown sound effect: ${name}`);
  if (info.builtin) throw new Error('cannot delete a built-in sound effect');

  try { await unlink(`${DIR}/${info.file}`); } catch {}
  delete meta.items[name];
  await saveMeta(meta);
  return { ok: true };
}

// Install one built-in effect into state/sfx/ + the sidecar. Prefers the
// repo-bundled audio (sounds/sfx/<name>.mp3) — a plain copy, no API call;
// falls back to ElevenLabs generation only when no bundled file exists.
// Returns true if the effect ended up installed.
async function installDefault(def, meta) {
  const file = `${def.name}.mp3`;
  const bundled = `${BUNDLE_DIR}/${file}`;

  if (await statOrNull(bundled)) {
    await copyFile(bundled, `${DIR}/${file}`);
    console.log(`[sfx] installed bundled default effect → ${def.name}`);
  } else if (isConfigured()) {
    await generateSfx(def.prompt, { durationSec: def.durationSec, outPath: `${DIR}/${file}` });
    console.log(`[sfx] generated default effect → ${def.name}`);
  } else {
    return false;
  }

  meta.items[def.name] = {
    name: def.name,
    description: (def.description || '').trim(),
    prompt: (def.prompt || '').trim(),
    durationSec: Number(def.durationSec) || null,
    file,
    builtin: true,
    createdAt: new Date().toISOString(),
  };
  return true;
}

// Called from server.js startup. Installs any missing built-in effects,
// preferring the repo-bundled audio so a fresh boot needs no ElevenLabs key.
// When neither a bundled file nor a key is available the library stays empty
// and the feature is invisible to the agent. Idempotent.
export async function ensureDefaults() {
  await mkdir(DIR, { recursive: true });
  const meta = await loadMeta();
  let installed = 0;
  for (const def of DEFAULT_SFX) {
    const existing = meta.items[def.name];
    if (existing && (await statOrNull(`${DIR}/${existing.file}`))) continue;
    try {
      if (await installDefault(def, meta)) installed++;
    } catch (err) {
      console.error(`[sfx] default "${def.name}" install failed:`, err.message);
    }
  }
  if (installed) await saveMeta(meta);
  if (!Object.keys(meta.items).length) {
    console.log('[sfx] no default sound effects available (no bundled files, no ElevenLabs key)');
  }
}
