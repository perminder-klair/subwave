// Shipped COMMUNITY persona catalog — DJ personas contributed via the
// community-submission flow (.github/workflows/persona-submission.yml), COPYd
// into the image alongside the code. Mirrors the community skill catalog
// (skills/loader.ts COMMUNITY_DIR): this is NOT a runtime store — it is a
// read-only catalog the operator browses (public /personas showcase, admin
// /admin/personas → Community) and *installs* into the settings.personas
// roster on demand (routes/personas.ts). An installed community persona is an
// ordinary roster persona — editable, deletable, no special posture.
//
// One entry per directory:
//
//   controller/src/personas/community/<slug>/PERSONA.md
//     frontmatter → the persona's portable knobs + provenance
//     body        → the soul (the character prose, 1-1000 chars)
//
// Station-specific fields are deliberately NOT part of the format: `tts`
// (engines/voices/keys differ per station — install applies the piper
// defaults), `avatar` (binary, uploaded locally), `skills` (installed sets
// differ — install uses null, the "all skills" roster default), and `id`
// (minted on install by settings.update()).

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, SLUG_RE } from '../skills/loader.js';
import { FREQUENCIES, SCRIPT_LENGTHS } from '../settings.js';

export const COMMUNITY_PERSONAS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'community');

// One entry in the shipped community persona catalog (browse-only). The fields
// mirror a roster persona's portable knobs so the install route can hand them
// straight to settings.update() and the UIs can render without a second fetch.
export interface CommunityPersona {
  slug: string;
  displayName: string;         // the DJ's on-air name (persona.name, ≤40)
  tagline?: string;            // ≤80
  soul: string;                // the character prose (PERSONA.md body, 1-1000)
  frequency: 'silent' | 'quiet' | 'moderate' | 'chatty' | 'aggressive';
  scriptLength: 'one-liner' | 'concise' | 'extended' | 'storyteller';
  djMode: boolean;
  humour?: number;             // tone dials 0-10; absent = neutral (5)
  localColour?: number;
  warmth?: number;
  language?: string;           // free-text on-air language, ≤60
  // Provenance stamped by the submission workflow when a persona is approved +
  // merged (.github/workflows/persona-submission.yml). Absent on hand-added
  // entries — parsed defensively, UI degrades gracefully.
  submittedBy?: string;        // GitHub login of the contributor who submitted it
  dateAdded?: string;          // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string;       // ISO date (YYYY-MM-DD) of the last catalog change
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Optional 0-10 integer dial. Anything unparsable → undefined (neutral
// downstream — settings normalizeDial defaults to 5).
function parseDial(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10) return undefined;
  return n;
}

// Parse one community catalog dir into a CommunityPersona, or null when it
// isn't a valid entry (no PERSONA.md, bad slug, empty soul, oversize fields).
// Same lenient-but-strict-on-identity posture as readCommunityDir (skills).
async function readCommunityPersonaDir(slug: string): Promise<CommunityPersona | null> {
  if (!SLUG_RE.test(slug)) return null;
  let raw: string;
  try {
    raw = await readFile(join(COMMUNITY_PERSONAS_DIR, slug, 'PERSONA.md'), 'utf8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const name = (data.name || slug).trim();
  if (name !== slug) return null; // name must match its folder, like skills
  const soul = body.trim();
  if (!soul || soul.length > 1000) return null; // the roster's hard bound
  const displayName = (data.displayName || titleCase(slug)).trim().slice(0, 40);
  return {
    slug,
    displayName,
    tagline: data.tagline?.trim().slice(0, 80) || undefined,
    soul,
    frequency: (FREQUENCIES as string[]).includes(data.frequency) ? data.frequency as CommunityPersona['frequency'] : 'moderate',
    scriptLength: (SCRIPT_LENGTHS as string[]).includes(data.scriptLength) ? data.scriptLength as CommunityPersona['scriptLength'] : 'concise',
    djMode: data.djMode === 'true',
    humour: parseDial(data.humour),
    localColour: parseDial(data.localColour),
    warmth: parseDial(data.warmth),
    language: data.language?.trim().slice(0, 60) || undefined,
    submittedBy: data.submittedBy?.trim() || undefined,
    dateAdded: data.dateAdded?.trim() || undefined,
    dateModified: data.dateModified?.trim() || undefined,
  };
}

// List the shipped community persona catalog (browse-only). Returns [] when
// the dir is absent. Never throws — a broken entry is skipped.
export async function listCommunityPersonas(): Promise<CommunityPersona[]> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(COMMUNITY_PERSONAS_DIR, { withFileTypes: true });
    entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return []; // no community/ dir shipped — nothing to browse
  }
  const out: CommunityPersona[] = [];
  for (const slug of entries.sort()) {
    const cp = await readCommunityPersonaDir(slug).catch(() => null);
    if (cp) out.push(cp);
  }
  return out;
}

// Read a single community catalog entry by slug (for the install route).
// Returns null when there's no such valid entry.
export async function readCommunityPersona(slug: string): Promise<CommunityPersona | null> {
  return readCommunityPersonaDir(slug);
}
