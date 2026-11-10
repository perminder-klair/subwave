// How a skill's CODE arrives from outside the station — a zip import or a
// backup restore — and the one rule both follow: a `tool.mjs` someone else
// wrote is never evaluated until the operator has read it and said so.
//
// The loader `import()`s every `state/skills/<slug>/tool.mjs` on every scan,
// enabled or not, and the catalog calls each tool's `ready()` on every
// GET /dj/skills — so "arrives disabled" alone never kept imported code from
// running. Instead an arriving tool is written as `tool.mjs.pending`, a name
// the loader never imports. `trustPendingTool` renames it into place on an
// explicit operator action (POST /dj/skills/:slug/tool/trust), and that rename
// is the only way quarantined code becomes live.
//
// A `tool.mjs` already on disk is untouched by any of this: it was either
// seeded from the image, hand-placed by the operator, or trusted through the
// review, so an upgraded station keeps running exactly the code it ran before.
import { createHash } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STATE_DIR } from '../config.js';
import {
  parseFrontmatter, readTemplate, discoverSeededKinds, SEEDED_KINDS, RESERVED_KINDS, SLUG_RE,
  TOOL_FILE, PENDING_TOOL_FILE,
} from './loader.js';

export { TOOL_FILE, PENDING_TOOL_FILE };

const SKILLS_DIR = resolve(STATE_DIR, 'skills');

// A skill bundle is text plus one small module. Shared by the zip import and
// the backup restore so the two cannot disagree on what is implausibly large.
export const SKILL_BUNDLE_MAX_ENTRIES = 20;
export const SKILL_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch { return null; }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * SKILL.md text whose `name:` is exactly `slug`, or null when it can't be made
 * so without touching anything else.
 *
 * The loader takes a skill's kind from `name:` and refuses one that is not a
 * lowercase slug, so an importer that lowercased the name to pick the folder
 * but wrote the file verbatim produced a folder that never loaded and blocked
 * its own re-import. Rewriting the one line keeps the folder and the file in
 * agreement; the re-parse is the proof that nothing else moved.
 */
export function withSkillName(skillMd: string, slug: string): string | null {
  const before = parseFrontmatter(skillMd);
  if ((before.data.name || '').trim() === slug) return skillMd;
  const m = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[\s\S]*)$/.exec(skillMd);
  if (!m) return null;
  const lines = m[2].split('\n');
  const idx = lines.findIndex(l => /^name\s*:/.test(l));
  if (idx === -1) return null;
  lines[idx] = `name: ${slug}${lines[idx].endsWith('\r') ? '\r' : ''}`;
  const next = m[1] + lines.join('\n') + m[3];
  const after = parseFrontmatter(next);
  if (after.data.name !== slug || after.body !== before.body) return null;
  if (after.malformed && !before.malformed) return null;
  return next;
}

/** Write arriving code where the loader will not import it. */
export async function quarantineTool(slug: string, code: Buffer): Promise<void> {
  const dir = join(SKILLS_DIR, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PENDING_TOOL_FILE), code);
}

export async function hasPendingTool(slug: string): Promise<boolean> {
  return exists(join(SKILLS_DIR, slug, PENDING_TOOL_FILE));
}

/** The quarantined source and its digest, for the operator to read. */
export async function readPendingTool(slug: string): Promise<{ source: string; sha256: string; bytes: number } | null> {
  const data = await readOrNull(join(SKILLS_DIR, slug, PENDING_TOOL_FILE));
  if (!data) return null;
  return { source: data.toString('utf8'), sha256: sha256(data), bytes: data.length };
}

/**
 * Promote the quarantined tool to `tool.mjs`. `expectedSha256` is the digest
 * the operator was shown: a pending file replaced between reading and trusting
 * (a second import, a restore) is refused rather than trusted unread.
 */
export async function trustPendingTool(
  slug: string,
  expectedSha256: string,
): Promise<'trusted' | 'missing' | 'changed'> {
  const dir = join(SKILLS_DIR, slug);
  const data = await readOrNull(join(dir, PENDING_TOOL_FILE));
  if (!data) return 'missing';
  if (sha256(data) !== expectedSha256) return 'changed';
  await rename(join(dir, PENDING_TOOL_FILE), join(dir, TOOL_FILE));
  return 'trusted';
}

export async function discardPendingTool(slug: string): Promise<boolean> {
  const path = join(SKILLS_DIR, slug, PENDING_TOOL_FILE);
  if (!(await exists(path))) return false;
  await rm(path, { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Backup restore
// ---------------------------------------------------------------------------

export type SkillMemberFile = 'SKILL.md' | typeof TOOL_FILE | typeof PENDING_TOOL_FILE;

/** One file a backup carries under `skills/<slug>/`. */
export interface SkillMember { slug: string; file: SkillMemberFile; data: Buffer }

export interface SkillRestoreResult {
  restored: string[];      // slugs whose SKILL.md was written
  quarantined: string[];   // slugs whose code now waits for review
  skipped: string[];       // human-readable `skills/<path>: why` lines
}

/**
 * Split a backup member path into a skill member, or a reason it is not one.
 * Only `skills/<slug>/SKILL.md` and its tool file are skill content; anything
 * else a skill folder holds is left out, as the zip import does.
 */
export function skillMemberOf(entryName: string): { slug: string; file: SkillMemberFile } | { reason: string } {
  const parts = entryName.replace(/\\/g, '/').split('/');
  if (parts[0] !== 'skills' || parts.length !== 3) return { reason: 'not a skill file' };
  const [, slug, file] = parts;
  if (!SLUG_RE.test(slug)) return { reason: 'folder is not a skill name' };
  if (file !== 'SKILL.md' && file !== TOOL_FILE && file !== PENDING_TOOL_FILE) {
    return { reason: 'only SKILL.md and tool.mjs are restored' };
  }
  return { slug, file };
}

/**
 * Restore the skill members of a backup through the import's guards.
 *
 * Different from a zip import in one deliberate way: a restore REPLACES an
 * existing SKILL.md (that is what restoring a station means, and settings are
 * replaced the same way), where an import refuses to. Code never replaces
 * anything live:
 *
 *  - byte-identical to the `tool.mjs` already on disk — nothing to do;
 *  - a seeded built-in's tool identical to the template this image ships —
 *    written live, since that is the code the seeder would write anyway;
 *  - anything else — quarantined as `tool.mjs.pending`, and any live tool the
 *    skill already had keeps running until the operator trusts the new one.
 */
export async function restoreSkillMembers(members: SkillMember[]): Promise<SkillRestoreResult> {
  if (!SEEDED_KINDS.size) await discoverSeededKinds();
  const out: SkillRestoreResult = { restored: [], quarantined: [], skipped: [] };

  const bySlug = new Map<string, { skillMd?: Buffer; tool?: Buffer }>();
  for (const m of members) {
    const slot = bySlug.get(m.slug) ?? {};
    if (m.file === 'SKILL.md') slot.skillMd = m.data;
    // A backup taken while a review was pending carries `.pending`; it is code
    // from the same place either way, so both spellings take the same path.
    else if (!slot.tool || m.file === TOOL_FILE) slot.tool = m.data;
    bySlug.set(m.slug, slot);
  }

  for (const [slug, { skillMd, tool }] of bySlug) {
    const seeded = SEEDED_KINDS.has(slug);
    if (RESERVED_KINDS.has(slug) && !seeded) {
      out.skipped.push(`skills/${slug}: shadows a reserved capability`);
      continue;
    }
    if (!skillMd) {
      out.skipped.push(`skills/${slug}: no SKILL.md in the backup`);
      continue;
    }
    const text = withSkillName(skillMd.toString('utf8'), slug);
    if (text == null) {
      out.skipped.push(`skills/${slug}: SKILL.md name does not match its folder`);
      continue;
    }
    if (!seeded && !parseFrontmatter(text).body) {
      out.skipped.push(`skills/${slug}: SKILL.md has an empty brief`);
      continue;
    }

    const dir = join(SKILLS_DIR, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), text, 'utf8');
    out.restored.push(slug);

    if (!tool) continue;
    const live = await readOrNull(join(dir, TOOL_FILE));
    if (live && live.equals(tool)) continue;
    if (seeded) {
      const tpl = await readTemplate(slug);
      const shipped = tpl?.toolPath ? await readOrNull(tpl.toolPath) : null;
      if (shipped && shipped.equals(tool)) {
        await writeFile(join(dir, TOOL_FILE), tool);
        continue;
      }
    }
    await quarantineTool(slug, tool);
    out.quarantined.push(slug);
  }
  return out;
}
