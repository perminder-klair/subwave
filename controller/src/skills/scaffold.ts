// Scaffold the 7 built-in skills as editable files under state/skills/<kind>/.
//
// On first boot we write one SKILL.md per built-in capability, seeded from the
// hardcoded CAPABILITIES table (skills/_agent.js) — the single source of truth.
// From then on the operator can edit those files (or use /admin/skills), and
// the loader (skills/loader.js) merges their contents back over the built-in as
// an override. The `news` file additionally carries a `feed:` line so the feed
// source + tone are operator-editable without touching .env (issue #193).
//
// Idempotent: an existing file is never clobbered, so hand-edits survive a
// restart. Writes are best-effort — a failure is logged, never fatal to boot.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STATE_DIR, config } from '../config.js';
import { queue } from '../broadcast/queue.js';
import { CAPABILITIES, effectiveContextFields } from './_agent.js';

const SKILLS_DIR = resolve(STATE_DIR, 'skills');

// Inverse of loader.js parseCooldownMs — render ms back to the shortest exact
// "Nd" | "Nh" | "Nm" form for a readable seeded frontmatter value.
export function msToCooldownStr(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '60m';
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

interface SkillFileFields {
  kind: string;
  label?: string;
  cooldown?: string;
  contextFields?: string[]; // "right now" fields the segment may mention (#471)
  feed?: string;        // news only
  feedMaxItems?: number; // news only
  brief?: string;
}

// Render + write a built-in skill's SKILL.md. Used by the scaffolder (seeding
// defaults) and the admin edit route (PUT /dj/skills/:kind/file). Creates the
// folder if absent and overwrites the file unconditionally — callers decide
// whether to call it (the scaffolder stats first; the route always writes).
export async function writeBuiltinSkillFile(fields: SkillFileFields): Promise<void> {
  const { kind } = fields;
  const lines = ['---', `name: ${kind}`];
  if (fields.label) lines.push(`label: ${fields.label}`);
  if (fields.cooldown) lines.push(`cooldown: ${fields.cooldown}`);
  // The "right now" fields this segment may weave in (issue #471). Seeded so
  // the knob is visible+editable in every scaffolded SKILL.md; add or drop
  // tokens (e.g. `weather`) to change what the segment is allowed to mention.
  if (fields.contextFields && fields.contextFields.length) lines.push(`context: ${fields.contextFields.join(', ')}`);
  if (fields.feed) lines.push(`feed: ${fields.feed}`);
  if (fields.feedMaxItems) lines.push(`feedMaxItems: ${fields.feedMaxItems}`);
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

// Write a SKILL.md for any built-in that doesn't already have one. Seeds the
// news feed from NEWS_FEED_URL (env) or the BBC default, preserving the
// 12-factor story on a fresh install; after first boot the file wins.
export async function scaffoldBuiltinSkills(): Promise<void> {
  for (const cap of CAPABILITIES) {
    try {
      const file = join(SKILLS_DIR, cap.kind, 'SKILL.md');
      if (await fileExists(file)) continue;
      const fields: SkillFileFields = {
        kind: cap.kind,
        label: cap.label,
        cooldown: msToCooldownStr(cap.cooldownMs),
        contextFields: effectiveContextFields(cap),
        brief: cap.desc,
      };
      if (cap.kind === 'news') {
        fields.feed = config.news.feedUrl; // already env-or-BBC (config.ts)
        fields.feedMaxItems = config.news.maxItems;
      }
      await writeBuiltinSkillFile(fields);
      queue.log('scheduler', `[skills] scaffolded built-in "${cap.kind}" → state/skills/${cap.kind}/SKILL.md`);
    } catch (err: any) {
      queue.log('error', `[skills] failed to scaffold "${cap.kind}": ${err?.message || err}`);
    }
  }
}
