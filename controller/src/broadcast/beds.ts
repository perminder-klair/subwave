// Bed library — instrumental beds the DJ talks over BETWEEN songs, so a long
// link doesn't have to be talked over the song it's introducing.
//
// Mirrors broadcast/sfx.ts: audio files on disk plus a JSON sidecar, with admin
// CRUD on top. Files live at <stateDir>/beds/<name>.mp3 — on the shared
// /var/sub-wave mount, so the path the controller writes into next.txt is one
// the broadcast container can actually open. The sidecar <stateDir>/beds.json
// maps name → { name, description, durationSec, file, source, createdAt }.
//
// Two deliberate differences from sfx:
//
//  1. No generate path. A stinger can be rendered from a text prompt; a bed
//     can't be TTS'd, so the only ways in are the bundled default and upload.
//  2. Defaults are DELETABLE. sfx built-ins are undeletable because a missing
//     stinger is harmless; a bed the operator finds annoying is the entire risk
//     of the feature (see radio.liq's disabled studio bed), so "delete it" must
//     work and must stick. `retired` records that, so ensureDefaults doesn't
//     resurrect it on the next boot.

import { readFile, writeFile, unlink, mkdir, stat, copyFile } from 'node:fs/promises';
import { STATE_DIR, SOUNDS_DIR } from '../config.js';
import { transcodeAudio, hasFfmpeg, extOf, isAcceptedAudio, probeDurationSec } from '../audio/audio-import.js';
import { escAnnotate } from '../music/subsonic.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { slugify } from '../util/slug.js';

// Floor on any bed's length. A bed is only ever cut SHORTER (liq_cue_out) and
// never looped, so it has to outlast the script it carries — bed-policy filters
// per-link on the real number, and this is the upload-time footgun guard. 30s
// covers a typical link with room; anything shorter is almost certainly a
// stinger that wandered into the wrong library.
export const MIN_DURATION_SEC = 30;

const DIR = `${STATE_DIR}/beds`;
const META = `${STATE_DIR}/beds.json`;

// The one bundled default. sounds/bed.mp3 is a 71s ambient loop already
// committed and baked into both the controller and broadcast images.
//
// NB: this is the same asset radio.liq's studio bed was disabled over
// ("audible/annoying under the DJ's voice during links", radio.liq bed_enabled).
// The reuse is deliberate: that failure was CONTINUOUS playback — a drone
// running forever underneath both the music and the voice. Here it plays alone
// for the length of one link and stops, which is a different exposure entirely.
// If it still grates, it's deletable, which is why defaults are deletable.
const DEFAULT_BEDS = [
  {
    name: 'ambient-room',
    description: 'warm ambient room tone — tonally neutral, sits under any key',
    bundled: `${SOUNDS_DIR}/bed.mp3`,
  },
];

async function loadMeta(): Promise<any> {
  try {
    const m = JSON.parse(await readFile(META, 'utf8'));
    return { items: m.items || {}, retired: Array.isArray(m.retired) ? m.retired : [] };
  } catch {
    return { items: {}, retired: [] };
  }
}

async function saveMeta(meta: any) {
  // Atomic: the drain path reads this sidecar at track transitions (catalog/
  // getPath in queue.maybePushBed), concurrently with admin upload/delete
  // saves — a torn write would momentarily read as an empty library.
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
      createdAt: info.createdAt,
      size: s.size,
    });
  }
  out.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
  return out;
}

// The slim view bed-policy.pickBed selects over: a name and the real measured
// length, which is the only thing selection actually gates on.
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

// The Liquidsoap URI for a bed cut to `bedSec` and ramping into the next song
// over `crossSec`. Three annotations, all of them mechanisms that already ship:
//
//   subwave_kind      — radio.liq's on_meta branches on this to keep the bed
//                       out of now-playing.json and to announce bed-playing.json.
//   liq_cue_out       — cue_cut(music) is already applied (radio.liq), so this
//                       trims the bed to exactly the length of the DJ's script.
//   liq_cross_duration— cross reads this to size the bed's OWN exit fade, which
//                       is what ramps the next song in under the closing words.
//
// No title/artist deliberately: a bed is not a song, and metadata is exactly
// what would leak it into the UI and the ICY title.
export function bedUri(path: string, { bedSec, crossSec }: { bedSec: number; crossSec: number }): string {
  const fields = [
    'subwave_kind="bed"',
    `liq_cue_out="${escAnnotate(bedSec.toFixed(2))}"`,
    `liq_cross_duration="${escAnnotate(crossSec.toFixed(2))}"`,
  ];
  return `annotate:${fields.join(',')}:${path}`;
}

// Import an operator-supplied audio file as a bed. Transcoded to MP3 when
// ffmpeg is available, otherwise stored as-is. No loudnorm — the bed's level
// against the voice is the operator's call, and the broadcast limiter catches
// peaks either way.
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

  // Length gate. Unlike sfx (where an unmeasurable duration is accepted), a bed
  // with no measured length is useless: bed-policy.pickBed can't gamble on it,
  // so it would sit in the library and never be selected. Reject it here with a
  // real reason rather than let it look installed and never air.
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
    createdAt: new Date().toISOString(),
  };
  await saveMeta(meta);
  return meta.items[slug];
}

// Delete a bed. Defaults are deletable (see the header) and stay deleted —
// `retired` is what ensureDefaults checks before reinstalling.
export async function remove(name: string) {
  const meta = await loadMeta();
  const info = meta.items[name];
  if (!info) throw new Error(`unknown bed: ${name}`);

  try { await unlink(`${DIR}/${info.file}`); } catch {}
  delete meta.items[name];
  if (info.source === 'bundled' && !meta.retired.includes(name)) meta.retired.push(name);
  await saveMeta(meta);
  return { ok: true };
}

// Called from server startup. Copies in any missing bundled default that the
// operator hasn't retired. Idempotent.
export async function ensureDefaults() {
  await mkdir(DIR, { recursive: true });
  const meta = await loadMeta();
  let installed = 0;

  for (const def of DEFAULT_BEDS) {
    if (meta.retired.includes(def.name)) continue;
    const existing = meta.items[def.name];
    if (existing && (await statOrNull(`${DIR}/${existing.file}`))) continue;
    if (!(await statOrNull(def.bundled))) continue;

    try {
      const file = `${def.name}.mp3`;
      await copyFile(def.bundled, `${DIR}/${file}`);
      const measured = await probeDurationSec(`${DIR}/${file}`);
      // Same gate as importAudio: a bed with no measured length can never be
      // selected (pickBed only trusts real numbers), so installing it would
      // show a bed in the library that never airs. Skip instead — the item is
      // never written, so the next boot retries once ffprobe is available.
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
        createdAt: new Date().toISOString(),
      };
      installed++;
      console.log(`[beds] installed bundled default bed → ${def.name}`);
    } catch (err) {
      console.error(`[beds] default "${def.name}" install failed:`, (err as Error).message);
    }
  }

  if (installed) await saveMeta(meta);
}
