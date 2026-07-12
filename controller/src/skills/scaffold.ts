// Seed the shipped built-in skills into state/skills/<kind>/ as full, editable
// skills — both SKILL.md AND tool.mjs.
//
// On boot we copy each built-in out of its read-only template
// (src/skills/builtins/<kind>/, the source of truth) into state/skills/<kind>/.
// From then on the operator owns those files: edit the brief in /admin/skills,
// or the tool.mjs on disk + Rescan, exactly like a custom skill. The loader
// (skills/loader.js) then scans state/skills as the single load root — built-ins
// are no longer special at load time, just pre-installed.
//
// Idempotent: an existing file is never clobbered, so hand-edits survive a
// restart. A MISSING file is restored — which is also how a deleted built-in
// folder heals on the next boot (the delete posture is disable-only). Writes are
// best-effort — a failure is logged, never fatal to boot.
//
// `resetBuiltinSkill()` is the opposite: it force-overwrites both files from the
// template, restoring the as-shipped skill (and pulling in a newer image's
// tool.mjs). It backs the admin "Reset to default" button.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STATE_DIR, config } from '../config.js';
import { queue } from '../broadcast/queue.js';
import { SEEDED_KINDS, discoverSeededKinds, readTemplate } from './loader.js';

const SKILLS_DIR = resolve(STATE_DIR, 'skills');

// Inverse of loader.js parseCooldownMs — render ms back to the shortest exact
// "Nd" | "Nh" | "Nm" form for a readable seeded frontmatter value. Kept here for
// the admin routes (the /dj/skills "defaults" payload), which speak in strings.
export function msToCooldownStr(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '60m';
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

interface SkillFileFields {
  kind: string;             // == the slug for a custom skill
  label?: string;
  cooldown?: string;
  contextFields?: string[]; // "right now" fields the segment may mention (#471)
  window?: 'any' | 'commute'; // custom skills only — emitted when 'commute'
  requiresKey?: string;       // custom skills only — env var the skill needs
  feed?: string;        // news only
  feedMaxItems?: number; // news only
  tags?: string[];      // freeform organisation tags
  brief?: string;
}

// Render + write a skill's SKILL.md from form fields. Used by the admin routes:
// the built-in edit route (PUT /dj/skills/:kind/file) and the custom-skill
// create/edit routes (POST /dj/skills, PUT /dj/skills/:slug/file). Creates the
// folder if absent and overwrites the file unconditionally. Never touches a
// sibling `tool.mjs`, so editing a skill's brief leaves its data tool intact.
export async function writeSkillFile(fields: SkillFileFields): Promise<void> {
  const { kind } = fields;
  const lines = ['---', `name: ${kind}`];
  if (fields.label) lines.push(`label: ${fields.label}`);
  if (fields.cooldown) lines.push(`cooldown: ${fields.cooldown}`);
  // The "right now" fields this segment may weave in (issue #471).
  if (fields.contextFields && fields.contextFields.length) lines.push(`context: ${fields.contextFields.join(', ')}`);
  // Custom-skill knobs. `window: any` is the loader default, so only the
  // restrictive `commute` value is worth writing.
  if (fields.window === 'commute') lines.push('window: commute');
  if (fields.requiresKey) lines.push(`requiresKey: ${fields.requiresKey}`);
  if (fields.feed) lines.push(`feed: ${fields.feed}`);
  if (fields.feedMaxItems) lines.push(`feedMaxItems: ${fields.feedMaxItems}`);
  if (fields.tags && fields.tags.length) lines.push(`tags: ${fields.tags.join(', ')}`);
  lines.push('---', (fields.brief || '').trim(), '');
  const dir = join(SKILLS_DIR, kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), lines.join('\n'), 'utf8');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Insert or replace a single flat `key: value` line inside a SKILL.md's
// frontmatter block, returning the new text. Used to seed news' feed /
// feedMaxItems into the (feed-less) template while keeping the rest verbatim.
function upsertFrontmatterKey(md: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(md)) return md.replace(re, `${key}: ${value}`);
  // Insert just before the closing '---' of the frontmatter block.
  const m = /^(---\s*\n[\s\S]*?\n)(---\s*\n)/.exec(md);
  if (!m) return md; // no frontmatter — nothing to do
  return md.slice(0, m[1].length) + `${key}: ${value}\n` + md.slice(m[1].length);
}

// The SKILL.md text to seed for a built-in: the template verbatim, except news'
// `feed:` / `feedMaxItems:` are seeded from NEWS_FEED_URL (env-or-BBC, via
// config) so the feed honours 12-factor on a fresh install (#193). After first
// boot the file wins (the seeder never clobbers it).
function seedSkillMd(kind: string, skillMd: string): string {
  if (kind !== 'news') return skillMd;
  let out = skillMd;
  if (config.news.feedUrl) out = upsertFrontmatterKey(out, 'feed', config.news.feedUrl);
  if (config.news.maxItems) out = upsertFrontmatterKey(out, 'feedMaxItems', String(config.news.maxItems));
  return out;
}

// Seed every shipped built-in into state/skills/<kind>/ as a full editable skill
// (SKILL.md + tool.mjs). Idempotent: existing files survive, missing files are
// restored. Best-effort — a per-skill failure is logged, never fatal to boot.
export async function seedBuiltinSkills(): Promise<void> {
  if (!SEEDED_KINDS.size) await discoverSeededKinds();
  for (const kind of SEEDED_KINDS) {
    try {
      const tpl = await readTemplate(kind);
      if (!tpl) continue;
      const dir = join(SKILLS_DIR, kind);
      await mkdir(dir, { recursive: true });

      const skillFile = join(dir, 'SKILL.md');
      if (!(await fileExists(skillFile))) {
        await writeFile(skillFile, seedSkillMd(kind, tpl.skillMd), 'utf8');
        queue.log('scheduler', `[skills] seeded built-in "${kind}" SKILL.md → state/skills/${kind}/`);
      }

      if (tpl.toolPath) {
        const toolFile = join(dir, 'tool.mjs');
        if (!(await fileExists(toolFile))) {
          await copyFile(tpl.toolPath, toolFile);
          queue.log('scheduler', `[skills] seeded built-in "${kind}" tool.mjs → state/skills/${kind}/`);
        }
      }
    } catch (err: any) {
      queue.log('error', `[skills] failed to seed "${kind}": ${err?.message || err}`);
    }
  }
}

// Force-restore a built-in to its shipped template — overwrite BOTH SKILL.md and
// tool.mjs in state/skills/<kind>/. Backs POST /dj/skills/:kind/reset; the way an
// operator reverts a broken edit or pulls in a newer image's tool.mjs. Throws on
// an unknown (non-seeded) kind so the route can answer 400.
export async function resetBuiltinSkill(kind: string): Promise<void> {
  if (!SEEDED_KINDS.size) await discoverSeededKinds();
  if (!SEEDED_KINDS.has(kind)) throw new Error(`"${kind}" is not a built-in skill`);
  const tpl = await readTemplate(kind);
  if (!tpl) throw new Error(`no shipped template for "${kind}"`);
  const dir = join(SKILLS_DIR, kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), seedSkillMd(kind, tpl.skillMd), 'utf8');
  if (tpl.toolPath) await copyFile(tpl.toolPath, join(dir, 'tool.mjs'));
  queue.log('scheduler', `[skills] reset built-in "${kind}" to shipped default`);
}
