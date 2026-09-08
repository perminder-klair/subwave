// Bed library — instrumental beds the DJ talks over between songs. Mirrors
// broadcast/sfx.ts: files at <stateDir>/beds/<name>.mp3 (on the shared
// /var/sub-wave mount, so the broadcast container can open what we write into
// next.txt) plus the <stateDir>/beds.json sidecar. The bundled default is a
// protected built-in; settings.beds.enabled is the way to silence beds, not
// deletion. Generation uses the ElevenLabs Music API, not the sfx sound path,
// because a bed needs >=30s of instrumental music.

import { readFile, writeFile, unlink, mkdir, stat, copyFile } from 'node:fs/promises';
import { STATE_DIR, SOUNDS_DIR } from '../config.js';
import { BED_MIN_SEC } from '../schemas/imaging.js';
import { transcodeAudio, hasFfmpeg, extOf, isAcceptedAudio, probeDurationSec } from '../audio/audio-import.js';
import { generateBed, BED_GEN_MAX_SEC } from '../audio/bed-gen.js';
import { escAnnotate } from '../music/subsonic.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { slugify } from '../util/slug.js';

// Upload-time floor: a bed is only ever cut shorter (liq_cue_out), never looped,
// so it must outlast the script it carries. Shared with the admin form via the
// imaging schema; bed-policy still filters per-link on the real number.
export const MIN_DURATION_SEC = BED_MIN_SEC;

const DIR = `${STATE_DIR}/beds`;
const META = `${STATE_DIR}/beds.json`;

// sounds/bed.mp3 is a 71s ambient loop baked into both images.
const DEFAULT_BEDS = [
  {
    name: 'ambient-room',
    description: 'warm ambient room tone — tonally neutral, sits under any key',
    bundled: `${SOUNDS_DIR}/bed.mp3`,
  },
];

async function loadMeta(): Promise<any> {
  // A legacy sidecar may carry a `retired` array; deliberately not read back.
  try {
    const m = JSON.parse(await readFile(META, 'utf8'));
    return { items: m.items || {} };
  } catch {
    return { items: {} };
  }
}

async function saveMeta(meta: any) {
  // Atomic: the drain path reads this sidecar at track transitions concurrently
  // with admin saves, and a torn write reads as an empty library.
  await writeFileAtomic(META, JSON.stringify(meta, null, 2));
}

async function statOrNull(p: string) {
  try { return await stat(p); } catch { return null; }
}

// The listed beds, with file existence verified.
export async function list() {
  const meta = await loadMeta();
  const out: any[] = [];
  for (const [name, info] of Object.entries(meta.items) as [string, any][]) {
    const s = await statOrNull(`${DIR}/${info.file}`);
    if (!s) continue;
    out.push({
      name,
      description: info.description || '',
      durationSec: info.durationSec ?? null,
      source: info.source || 'upload',
      builtin: !!info.builtin,
      createdAt: info.createdAt,
      size: s.size,
    });
  }
  // Built-ins last so operator-created beds appear on top (matches sfx.list).
  out.sort((a: any, b: any) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return (a.name || '').localeCompare(b.name || '');
  });
  return out;
}

// The slim view bed-policy.pickBed selects over.
export async function catalog(): Promise<{ name: string; durationSec: number | null }[]> {
  return (await list()).map((b: any) => ({ name: b.name, durationSec: b.durationSec }));
}

// Absolute path to a bed's audio file, or null if unknown / missing.
export async function getPath(name: string) {
  const meta = await loadMeta();
  const info = meta.items[name];
  if (!info) return null;
  const filePath = `${DIR}/${info.file}`;
  return (await statOrNull(filePath)) ? filePath : null;
}

// Liquidsoap URI for a bed cut to `bedSec`, ramping into the next song over
// `crossSec`. subwave_kind is what radio.liq's on_meta branches on to keep the bed
// out of now-playing.json and to write bed-playing.json. No title/artist on
// purpose: metadata would leak the bed into the UI and the ICY title.
export function bedUri(path: string, { bedSec, crossSec }: { bedSec: number; crossSec: number }): string {
  const fields = [
    'subwave_kind="bed"',
    `liq_cue_out="${escAnnotate(bedSec.toFixed(2))}"`,
    `liq_cross_duration="${escAnnotate(crossSec.toFixed(2))}"`,
  ];
  return `annotate:${fields.join(',')}:${path}`;
}

// Transcoded to MP3 when ffmpeg is available, otherwise stored as-is. No loudnorm:
// the bed's level against the voice is the operator's call.
export async function importAudio(
  buffer: Buffer,
  { name, description = '', originalName = '' }: { name: string; description?: string; originalName?: string },
) {
  const slug = slugify(name);
  if (!slug) throw new Error('Bed name is required');
  if (!buffer?.length) throw new Error('Empty audio file');
  if (originalName && !isAcceptedAudio(originalName)) {
    throw new Error(`Unsupported audio type: ${originalName}`);
  }
  await mkdir(DIR, { recursive: true });

  const meta = await loadMeta();
  if (meta.items[slug]) throw new Error(`a bed named "${slug}" already exists`);

  let file: string;
  if (await hasFfmpeg()) {
    file = `${slug}.mp3`;
    await transcodeAudio(buffer, { outPath: `${DIR}/${file}`, format: 'mp3' });
  } else {
    file = `${slug}.${extOf(originalName) || 'mp3'}`;
    await writeFile(`${DIR}/${file}`, buffer);
  }

  // Unlike sfx, an unmeasurable duration is rejected: pickBed skips beds with no
  // measured length, so it would sit in the library and never air.
  const measured = await probeDurationSec(`${DIR}/${file}`);
  if (measured == null) {
    await unlink(`${DIR}/${file}`).catch(() => {});
    throw new Error('could not measure the length of that file — a bed needs a known duration to be trimmed to a link');
  }
  if (measured < MIN_DURATION_SEC) {
    await unlink(`${DIR}/${file}`).catch(() => {});
    throw new Error(`"${originalName || slug}" is ${Math.round(measured)}s — beds must be at least ${MIN_DURATION_SEC}s so they outlast the DJ's script`);
  }

  meta.items[slug] = {
    name: slug,
    description: (description || '').trim(),
    durationSec: measured,
    file,
    source: 'upload',
    builtin: false,
    createdAt: new Date().toISOString(),
  };
  await saveMeta(meta);
  return meta.items[slug];
}

// Generate an instrumental bed from a prompt (ElevenLabs Music API,
// force_instrumental). Length defaults to 45s, clamped to
// [MIN_DURATION_SEC, BED_GEN_MAX_SEC].
export async function create(
  { name, description = '', prompt, durationSec }:
    { name: string; description?: string; prompt: string; durationSec?: number | string },
) {
  const slug = slugify(name);
  if (!slug) throw new Error('Bed name is required');
  if (!prompt || !prompt.trim()) throw new Error('Bed generation prompt is required');
  await mkdir(DIR, { recursive: true });

  // Reject an existing name so generation can't clobber another bed's audio, or
  // flip a protected built-in to deletable.
  const meta = await loadMeta();
  if (meta.items[slug]) throw new Error(`a bed named "${slug}" already exists`);

  const requested = Number(durationSec);
  const wantSec = Math.min(
    BED_GEN_MAX_SEC,
    Math.max(MIN_DURATION_SEC, Number.isFinite(requested) && requested > 0 ? requested : 45),
  );

  const file = `${slug}.mp3`;
  await generateBed(prompt.trim(), { durationSec: wantSec, outPath: `${DIR}/${file}` });

  // Same gate as importAudio: the probe is the truth, not the requested length.
  const measured = await probeDurationSec(`${DIR}/${file}`);
  if (measured == null || measured < MIN_DURATION_SEC) {
    await unlink(`${DIR}/${file}`).catch(() => {});
    throw new Error(measured == null
      ? 'could not measure the generated bed — is ffprobe installed?'
      : `the generated bed came back only ${Math.round(measured)}s — beds must be at least ${MIN_DURATION_SEC}s`);
  }

  meta.items[slug] = {
    name: slug,
    description: (description || '').trim(),
    prompt: prompt.trim(),
    durationSec: measured,
    file,
    source: 'generated',
    builtin: false,
    createdAt: new Date().toISOString(),
  };
  await saveMeta(meta);
  return meta.items[slug];
}

// The bundled default is protected and refuses deletion.
export async function remove(name: string) {
  const meta = await loadMeta();
  const info = meta.items[name];
  if (!info) throw new Error(`unknown bed: ${name}`);
  if (info.builtin) throw new Error('cannot delete the built-in bed');

  try { await unlink(`${DIR}/${info.file}`); } catch {}
  delete meta.items[name];
  await saveMeta(meta);
  return { ok: true };
}

// Called from server startup. Idempotent; an item that exists but isn't flagged
// builtin is upgraded in place rather than re-copied.
export async function ensureDefaults() {
  await mkdir(DIR, { recursive: true });
  const meta = await loadMeta();
  let changed = 0;

  for (const def of DEFAULT_BEDS) {
    const existing = meta.items[def.name];
    if (existing && (await statOrNull(`${DIR}/${existing.file}`))) {
      if (!existing.builtin) { existing.builtin = true; changed++; }
      continue;
    }
    if (!(await statOrNull(def.bundled))) continue;

    try {
      const file = `${def.name}.mp3`;
      await copyFile(def.bundled, `${DIR}/${file}`);
      const measured = await probeDurationSec(`${DIR}/${file}`);
      // Same gate as importAudio. Nothing is written on a skip, so the next boot
      // retries once ffprobe is available.
      if (measured == null || measured < MIN_DURATION_SEC) {
        await unlink(`${DIR}/${file}`).catch(() => {});
        console.warn(`[beds] default "${def.name}" skipped — ${
          measured == null ? 'duration unmeasurable (is ffprobe installed?)' : `only ${Math.round(measured)}s`
        }; will retry next boot`);
        continue;
      }
      meta.items[def.name] = {
        name: def.name,
        description: def.description,
        durationSec: measured,
        file,
        source: 'bundled',
        builtin: true,
        createdAt: new Date().toISOString(),
      };
      changed++;
      console.log(`[beds] installed bundled default bed → ${def.name}`);
    } catch (err) {
      console.error(`[beds] default "${def.name}" install failed:`, (err as Error).message);
    }
  }

  if (changed) await saveMeta(meta);
}
