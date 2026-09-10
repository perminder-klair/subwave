// Admin-gated DJ command center behind /admin/dash. Manual triggers are an
// operator override: they bypass the shouldFire frequency gate and cooldowns.
import express from 'express';
import cron from 'node-cron';
import AdmZip from 'adm-zip';
import { requireAdmin } from '../middleware/auth.js';
import * as blocklist from '../music/blocklist.js';
import { zipUpload } from '../middleware/upload.js';
import { queue } from '../broadcast/queue.js';
import * as dj from '../llm/dj.js';
import * as subsonic from '../music/subsonic.js';
import * as library from '../music/library.js';
import { isInstrumental } from '../music/lyric-vocal.js';
import * as settings from '../settings.js';
import { runStationId, runHourlyCheck, runLink, runBanter, runProgrammeIntro, runProgrammeFeature, runProgrammeOutro, refreshAutoPlaylist, syncSkillCrons } from '../broadcast/scheduler.js';
import { skillCatalog, runCapability, effectiveContextFields } from '../skills/_agent.js';
import * as sfxLib from '../broadcast/sfx.js';
import { loadSkills, loadedCapabilities, parseFrontmatter, parseTags, SEEDED_KINDS, RESERVED_KINDS, SLUG_RE, readTemplate, listCommunitySkills, readCommunitySkill } from '../skills/loader.js';
import {
  builtinSkillFileSchema,
  customSkillFileSchema,
  skillCreateSchema,
  skillFieldsFrom,
  type SkillFileParsed,
} from '../schemas/skill.js';
import { validateBody } from '../middleware/validate.js';
import { firstMessage } from '../util/zod-error.js';
import { writeSkillFile, msToCooldownStr, resetBuiltinSkill } from '../skills/scaffold.js';
import { coerceConfigValues, readConfigValues, type SkillConfigField } from '../skills/config-fields.js';
import { mapPool } from '../util/async-pool.js';
import { readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STATE_DIR } from '../config.js';
import { skipTrack } from '../broadcast/liquidsoap-control.js';
import { getFullContext } from '../context.js';
import { randomUUID } from 'node:crypto';
import * as silenceTrim from '../music/silence-trim.js';
import { nextShowBoundaryMs } from '../broadcast/show-boundary.js';
import { planBlock, blockLabel, blockPlayableSec, type BlockSong } from '../broadcast/block-queue.js';
import {
  queueBlockSchema,
  QUEUE_BLOCK_ARTIST_LIMIT_DEFAULT,
  QUEUE_BLOCK_MAX_TRACKS,
  type QueueBlockBody,
} from '../schemas/dj.js';

export const router = express.Router();

// Structurally the SkillFileFields writeSkillFile (skills/scaffold.ts) consumes.
interface SkillFields {
  kind: string;
  label?: string;
  cooldown?: string;
  cron?: string;
  cronOnly?: boolean;
  contextFields?: string[];
  window?: 'any' | 'commute';
  requiresKey?: string;
  config?: Record<string, string | number>;
  configKeys?: string[];
  tags?: string[];
  brief?: string;
}

// Read off the LOADED capability, never off the kind string: hardcoding the kind
// made a renamed copy of News lose its feed field (#1300).
function declaredConfigFields(kind: string): SkillConfigField[] {
  const cap = loadedCapabilities().find(c => c.kind === kind);
  return (cap?.configFields as SkillConfigField[] | undefined) || [];
}

// Fallback source of knob values when the state SKILL.md can't be read.
function loadedConfig(kind: string): Record<string, string> | null {
  const cap = loadedCapabilities().find(c => c.kind === kind);
  return (cap?.config as Record<string, string> | undefined) || null;
}

// Knob values to persist plus the key list writeSkillFile is authoritative for.
// Prefers `config`, then top-level keys (pre-#1300 shape), then what's on disk:
// writeSkillFile rewrites the whole SKILL.md, so a line not emitted is deleted.
// Throws on an invalid value; callers turn that into a 400.
function resolveConfig(kind: string, body: any): { config: Record<string, string | number>; configKeys: string[] } {
  const fields = declaredConfigFields(kind);
  const configKeys = fields.map(f => f.key);
  if (!fields.length) return { config: {}, configKeys };
  if (body?.config !== undefined) return { config: coerceConfigValues(fields, body.config), configKeys };
  if (fields.some(f => body?.[f.key] !== undefined)) return { config: coerceConfigValues(fields, body), configKeys };
  return { config: readConfigValues(fields, loadedConfig(kind)), configKeys };
}

// The subset of a Subsonic song toAdminRow reads to build a queue-ready row.
interface AdminSong {
  id: string;
  // Raw-Subsonic only; the never-play match prefers these over the name
  // fallback, so keep them even though no admin row renders them.
  albumId?: string | null;
  artistId?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  genre?: string | null;
  duration?: number | null;
  path?: string | null;
  replayGain?: { trackGain?: number | null; trackPeak?: number | null } | null;
}

const SAY_TEXT_MAX = 500;
// Duck level: 'dj-speak' → say.txt (heavy duck, solo DJ moment);
// 'link' → intro.txt (light duck, voice over the track).
const SAY_KINDS = ['dj-speak', 'link'];

router.get('/dj/skills', requireAdmin, (req, res) => {
  res.json({ skills: skillCatalog() });
});

// Reload skills from state/skills without a controller restart.
router.post('/dj/skills/rescan', requireAdmin, async (req, res) => {
  try {
    const caps = await loadSkills();
    syncSkillCrons();
    queue.log('scheduler', `[skills] rescanned — ${caps.length} skill(s) loaded`);
    res.json({ skills: skillCatalog(), custom: caps.filter((c) => !c.seeded).length });
  } catch (err) {
    queue.log('error', `/dj/skills/rescan failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Browse-only catalog shipped in the image; nothing airs until installed.
router.get('/dj/skills/community', requireAdmin, async (req, res) => {
  try {
    const catalog = await listCommunitySkills();
    const annotated = await Promise.all(catalog.map(async (c) => ({
      ...c,
      installed: await skillFileExists(c.slug),
      reserved: RESERVED_KINDS.has(c.slug),
    })));
    res.json({ community: annotated });
  } catch (err) {
    queue.log('error', `/dj/skills/community failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Install a catalog skill as an ordinary custom skill. Arrives DISABLED (loader
// posture). Rejects reserved names and re-installs (409).
router.post('/dj/skills/community/:slug/install', requireAdmin, async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: `invalid skill name: ${slug}` });
  }
  if (RESERVED_KINDS.has(slug)) {
    return res.status(400).json({ error: `"${slug}" is reserved — it shadows a built-in capability and can't be installed` });
  }
  if (await skillFileExists(slug)) {
    return res.status(409).json({ error: `a skill named "${slug}" is already installed` });
  }

  const cs = await readCommunitySkill(slug);
  if (!cs) {
    return res.status(404).json({ error: `no such community skill: ${slug}` });
  }

  let fields: SkillFields;
  try {
    // Same builder as create/edit, so a bad catalog entry fails here rather than
    // writing a skill the loader would later reject.
    fields = buildCustomSkillFields(slug, {
      brief: cs.brief,
      label: cs.label,
      cooldown: cs.cooldown,
      context: cs.context,
      window: cs.window,
      // cron/cronOnly must stay in this allowlist: the zip-import path writes
      // SKILL.md verbatim, so omitting them makes the two install routes differ.
      cron: cs.cron,
      cronOnly: cs.cronOnly,
      cohosts: cs.cohosts,
    });
  } catch (err) {
    return res.status(400).json({ error: `community skill "${slug}" is malformed: ${err.message}` });
  }
  if (rejectInvalidCron(res, fields)) return;

  try {
    await writeSkillFile(fields);
    await loadSkills();
    syncSkillCrons();
    queue.log('scheduler', `[skills] community "${slug}" installed via admin UI (disabled)`);
    res.json({ skills: skillCatalog() });
  } catch (err) {
    queue.log('error', `POST /dj/skills/community/${slug}/install failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Download a skill as a .zip (SKILL.md + tool.mjs), files at the archive root.
// Auth-gated, so the browser fetches via adminFetch → blob, not a plain <a>.
router.get('/dj/skills/:slug/export', requireAdmin, async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: `invalid skill name: ${slug}` });
  if (!(await skillFileExists(slug))) return res.status(404).json({ error: `no such skill: ${slug}` });
  try {
    const dir = join(SKILLS_DIR, slug);
    const zip = new AdmZip();
    zip.addLocalFile(join(dir, 'SKILL.md'));           // -> SKILL.md at root
    if (await skillHasTool(slug)) zip.addLocalFile(join(dir, 'tool.mjs'));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-skill.zip"`);
    res.send(zip.toBuffer());
  } catch (err) {
    queue.log('error', `GET /dj/skills/${slug}/export failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Zip-slip guard: no absolute paths, no '..' (mirrors backup.ts isSafeEntry).
function isSafeZipEntry(entryName: string): boolean {
  const n = entryName.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').includes('..');
}

// Install a skill from an uploaded .zip. Slug comes from SKILL.md `name:`, not
// the zip filename. Only SKILL.md + tool.mjs are extracted, zip-slip checked and
// size/entry capped; the skill arrives DISABLED and `hasTool` flags a code drop.
router.post('/dj/skills/import', requireAdmin, zipUpload('file'), async (req, res) => {
  const file = (req as { file?: { buffer?: Buffer } }).file;
  if (!file?.buffer?.length) return res.status(400).json({ error: 'expected a .zip file in the "file" field' });

  let zip: AdmZip;
  try { zip = new AdmZip(file.buffer); } catch { return res.status(400).json({ error: 'not a valid zip file' }); }

  const entries = zip.getEntries();
  if (entries.length > 20) return res.status(400).json({ error: 'zip has too many files for a skill bundle' });
  // Zip-bomb guard: reject if the uncompressed total is implausible for a skill.
  const totalRaw = entries.reduce((n, e) => n + (e.header?.size || 0), 0);
  if (totalRaw > 8 * 1024 * 1024) return res.status(400).json({ error: 'skill bundle is too large uncompressed' });

  // Accept only SKILL.md + tool.mjs (by basename), anywhere safe in the archive.
  let skillMdEntry: AdmZip.IZipEntry | null = null;
  let toolEntry: AdmZip.IZipEntry | null = null;
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!isSafeZipEntry(e.entryName)) return res.status(400).json({ error: `unsafe path in zip: ${e.entryName}` });
    const base = e.entryName.replace(/\\/g, '/').split('/').pop();
    if (base === 'SKILL.md' && !skillMdEntry) skillMdEntry = e;
    else if (base === 'tool.mjs' && !toolEntry) toolEntry = e;
  }
  if (!skillMdEntry) return res.status(400).json({ error: 'zip has no SKILL.md — not a skill bundle' });

  const skillMd = skillMdEntry.getData().toString('utf8');
  const { data, body } = parseFrontmatter(skillMd);
  const slug = (data.name || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'SKILL.md has no valid "name:" — cannot determine the skill slug' });
  if (RESERVED_KINDS.has(slug)) return res.status(400).json({ error: `"${slug}" is reserved — it shadows a built-in capability` });
  if (!body.trim()) return res.status(400).json({ error: 'SKILL.md has an empty brief' });
  if (await skillFileExists(slug)) return res.status(409).json({ error: `a skill named "${slug}" is already installed` });

  try {
    const dir = join(SKILLS_DIR, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), skillMd, 'utf8');
    const hasTool = !!toolEntry;
    if (toolEntry) await writeFile(join(dir, 'tool.mjs'), toolEntry.getData());
    await loadSkills();
    syncSkillCrons();
    queue.log('scheduler', `[skills] imported "${slug}" from zip${hasTool ? ' (with tool.mjs)' : ''} via admin UI (disabled)`);
    res.json({ skills: skillCatalog(), slug, hasTool });
  } catch (err) {
    queue.log('error', `POST /dj/skills/import failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Custom skills live at state/skills/<slug>/SKILL.md (prompt-only). Validation
// reuses SLUG_RE / RESERVED_KINDS / dj.CONTEXT_FIELDS so it can't drift from the
// loader. writeSkillFile never touches a sibling tool.mjs.
const SKILLS_DIR = resolve(STATE_DIR, 'skills');

async function skillFileExists(slug: string): Promise<boolean> {
  try { await stat(join(SKILLS_DIR, slug, 'SKILL.md')); return true; } catch { return false; }
}

// A tool.mjs beside SKILL.md is edited on disk, not through this form.
async function skillHasTool(slug: string): Promise<boolean> {
  try { await stat(join(SKILLS_DIR, slug, 'tool.mjs')); return true; } catch { return false; }
}

// Adapter over the shared skill schema: throws Error(message) on the first
// invalid field, which callers map to a 400. The slug is immutable identity.
function buildCustomSkillFields(slug: string, b: unknown): SkillFields {
  const parsed = customSkillFileSchema.safeParse(b);
  if (!parsed.success) throw new Error(firstMessage(parsed.error));
  return skillFieldsFrom(slug, parsed.data);
}

// SKILL_CRON_RE (schemas/skill.ts) can only count fields, so the range rules are
// node-cron's to answer and only this layer can ask. A form submit REFUSES an
// unregisterable expression; a hand-edited SKILL.md is saved-and-skipped instead.
// Returns true (and the 400) when it fires.
function rejectInvalidCron(res: express.Response, fields: SkillFields): boolean {
  const expr = fields.cron;
  if (!expr || cron.validate(expr)) return false;
  const error = `"${expr}" is not a cron expression node-cron can run — check each field's range`;
  res.status(400).json({ error, fieldErrors: { cron: error } });
  return true;
}

// Read a skill's SKILL.md to prefill the admin edit form. Built-ins fall back to
// live defaults when unscaffolded; unknown custom slugs 404.
router.get('/dj/skills/:kind/file', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  const cat = skillCatalog().find(s => s.kind === kind);
  // Knobs the skill declares for itself, so a renamed copy keeps them (#1300).
  const configFields = declaredConfigFields(kind);

  if (SEEDED_KINDS.has(kind)) {
    // Read from the TEMPLATE, not the live state copy, so "Reset to default"
    // shows the as-shipped brief. Knob values stay out: the reset is server-side.
    const tpl = await readTemplate(kind);
    const defaults = tpl ? {
      label: tpl.data.label || kind,
      cooldown: tpl.data.cooldown || '60m',
      context: (effectiveContextFields({ contextFields: tpl.data.context ?? tpl.data.contextFields }) || []).join(', '),
      cohosts: String(tpl.data.cohosts).trim().toLowerCase() === 'true',
      tags: parseTags(tpl.data.tags),
      brief: tpl.body || '',
    } : null;

    const file = join(SKILLS_DIR, kind, 'SKILL.md');
    try {
      const raw = await readFile(file, 'utf8');
      const { data, body } = parseFrontmatter(raw);
      return res.json({
        kind,
        custom: false,
        exists: true,
        label: data.label || cat?.label || kind,
        cooldown: data.cooldown || msToCooldownStr(cat?.cooldownMs || 0),
        // Prefer the file's own context list; fall back to the effective set (#471).
        context: (data.context ?? data.contextFields)?.trim() || (cat?.contextFields || []).join(', '),
        knownContextFields: [...dj.CONTEXT_FIELDS],
        cron: data.cron?.trim() || null,
        // Only reachable from a hand-edited SKILL.md; the editor is where it is
        // fixable, so it has to be surfaced there.
        cronInvalid: !!data.cron?.trim() && !cron.validate(data.cron.trim()),
        cronOnly: String(data.cronOnly).trim().toLowerCase() === 'true',
        cohosts: String(data.cohosts).trim().toLowerCase() === 'true',
        configFields,
        config: readConfigValues(configFields, data),
        tags: parseTags(data.tags),
        brief: body || cat?.description || '',
        hasTool: await skillHasTool(kind),
        defaults,
      });
    } catch {
      // No file yet: hand back live built-in defaults so the form prefills.
      return res.json({
        kind,
        custom: false,
        exists: false,
        label: cat?.label || kind,
        cooldown: msToCooldownStr(cat?.cooldownMs || 0),
        context: (cat?.contextFields || []).join(', '),
        cohosts: !!cat?.cohosts,
        knownContextFields: [...dj.CONTEXT_FIELDS],
        configFields,
        config: readConfigValues(configFields, loadedConfig(kind)),
        tags: cat?.tags || [],
        brief: cat?.description || '',
        hasTool: await skillHasTool(kind),
        defaults,
      });
    }
  }

  // Custom skill — prefill the edit form from its SKILL.md.
  if (!SLUG_RE.test(kind)) {
    return res.status(400).json({ error: `invalid skill name: ${kind}` });
  }
  try {
    const raw = await readFile(join(SKILLS_DIR, kind, 'SKILL.md'), 'utf8');
    const { data, body } = parseFrontmatter(raw);
    res.json({
      kind,
      custom: true,
      exists: true,
      configFields,
      config: readConfigValues(configFields, data),
      label: data.label || cat?.label || kind,
      cooldown: data.cooldown || (cat?.cooldownMs ? msToCooldownStr(cat.cooldownMs) : ''),
      context: (data.context ?? data.contextFields)?.trim() || (cat?.contextFields || []).join(', '),
      knownContextFields: [...dj.CONTEXT_FIELDS],
      window: data.window === 'commute' ? 'commute' : 'any',
      requiresKey: data.requiresKey || '',
      cron: data.cron?.trim() || null,
      cronInvalid: !!data.cron?.trim() && !cron.validate(data.cron.trim()),
      cronOnly: String(data.cronOnly).trim().toLowerCase() === 'true',
      cohosts: String(data.cohosts).trim().toLowerCase() === 'true',
      tags: parseTags(data.tags),
      hasTool: await skillHasTool(kind),
      brief: body || '',
    });
  } catch {
    res.status(404).json({ error: `no such skill: ${kind}` });
  }
});

// Create a custom prompt-only skill; it arrives DISABLED (loader posture). Shape
// is validated by the shared schema; the two rules left here are answers about
// the live install, and both name a FIELD so the operator can retype the slug.
router.post('/dj/skills', requireAdmin, validateBody(skillCreateSchema), async (req, res) => {
  const { name, ...rest } = req.body as { name: string } & SkillFileParsed;
  if (RESERVED_KINDS.has(name)) {
    return res.status(400).json({
      error: `"${name}" is reserved — it shadows a built-in capability, pick another name`,
      fieldErrors: { name: `"${name}" is reserved — it shadows a built-in capability, pick another name` },
    });
  }
  if (await skillFileExists(name)) {
    return res.status(409).json({
      error: `a skill named "${name}" already exists`,
      fieldErrors: { name: `a skill named "${name}" already exists` },
    });
  }

  const fields: SkillFields = skillFieldsFrom(name, rest);
  if (rejectInvalidCron(res, fields)) return;

  try {
    await writeSkillFile(fields);
    await loadSkills();
    syncSkillCrons();
    queue.log('scheduler', `[skills] custom "${name}" created via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err) {
    queue.log('error', `POST /dj/skills (${name}) failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Write a skill's SKILL.md from the admin edit form, then reload.
router.put('/dj/skills/:kind/file', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  const b = req.body || {};

  // Custom skill edit: same validation as create, minus the immutable slug.
  if (!SEEDED_KINDS.has(kind)) {
    if (!SLUG_RE.test(kind)) {
      return res.status(400).json({ error: `invalid skill name: ${kind}` });
    }
    if (!(await skillFileExists(kind))) {
      return res.status(404).json({ error: `no such custom skill: ${kind} — create it first` });
    }
    let fields: SkillFields;
    try {
      fields = buildCustomSkillFields(kind, b);
      // Without this the rewrite drops knobs the skill's tool.mjs declares (#1300).
      Object.assign(fields, resolveConfig(kind, b));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (rejectInvalidCron(res, fields)) return;
    try {
      await writeSkillFile(fields); // rewrites SKILL.md only; a sibling tool.mjs is left intact
      await loadSkills();
      syncSkillCrons();
      queue.log('scheduler', `[skills] custom "${kind}" edited via admin UI`);
      return res.json({ skills: skillCatalog() });
    } catch (err) {
      queue.log('error', `PUT /dj/skills/${kind}/file failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // Built-in edit: same schema as a custom skill minus window/requiresKey, which
  // a built-in takes from its shipped template.
  const parsed = builtinSkillFileSchema.safeParse(b);
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error) });
  const fields: SkillFields = skillFieldsFrom(kind, parsed.data);
  if (rejectInvalidCron(res, fields)) return;

  // Read off the RAW body: the declaration is runtime data from tool.mjs, so the
  // schema above deliberately does not own this tail.
  try {
    Object.assign(fields, resolveConfig(kind, b));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    await writeSkillFile(fields);
    await loadSkills();
    syncSkillCrons();
    queue.log('scheduler', `[skills] built-in "${kind}" edited via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err) {
    queue.log('error', `PUT /dj/skills/${kind}/file failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Set exactly which DJs run this skill (writes the same personas[].skills field
// as PersonaSkillsCard). The read-modify-write is server-side so the null
// sentinel ("all skills") is interpreted in one place.
router.put('/dj/skills/:slug/personas', requireAdmin, async (req, res) => {
  const slug = req.params.slug;
  const catalog = skillCatalog();
  if (!catalog.some((sk) => sk.name === slug)) {
    return res.status(404).json({ error: `no such skill: ${slug}` });
  }

  const raw = req.body?.personaIds;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    return res.status(400).json({ error: 'personaIds must be an array of persona ids' });
  }
  const want = new Set<string>(raw);
  const s = settings.get();
  const known = new Set(s.personas.map((p) => p.id));
  const unknown = [...want].filter((id) => !known.has(id));
  if (unknown.length) {
    return res.status(400).json({ error: `unknown persona id(s): ${unknown.join(', ')}` });
  }

  const allSlugs = catalog.map((sk) => sk.name);
  let changed = false;
  const personas = s.personas.map((p) => {
    // `== null` must cover the "all skills" sentinel AND an absent key: the
    // seeded roster carries no `skills` until personas are saved once.
    const has = p.skills == null || p.skills.includes(slug);
    const should = want.has(p.id);
    if (has === should) return p;
    changed = true;
    // `should && !has` implies p.skills is an array (absent would mean has=true).
    if (should) return { ...p, skills: [...p.skills, slug] };
    const base = p.skills == null ? allSlugs : p.skills;
    return { ...p, skills: base.filter((sl) => sl !== slug) };
  });

  try {
    if (changed) await settings.update({ personas });
    queue.log('scheduler', `[skills] "${slug}" DJ assignments updated via admin UI`);
    res.json({
      personas: personas.map((p) => ({
        id: p.id,
        name: p.name,
        hasSkill: p.skills == null || p.skills.includes(slug),
      })),
    });
  } catch (err) {
    queue.log('error', `PUT /dj/skills/${slug}/personas failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Restore a built-in from the image template, overwriting BOTH SKILL.md and
// tool.mjs (the seeder won't auto-apply a newer tool.mjs once the file exists).
router.post('/dj/skills/:kind/reset', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  if (!SEEDED_KINDS.has(kind)) {
    return res.status(400).json({ error: `"${kind}" is not a built-in skill — only built-ins can be reset to default` });
  }
  try {
    await resetBuiltinSkill(kind);
    await loadSkills();
    syncSkillCrons();
    queue.log('scheduler', `[skills] built-in "${kind}" reset to default via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err) {
    queue.log('error', `POST /dj/skills/${kind}/reset failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Remove a custom skill's whole folder. Built-ins can only be disabled; the
// seeder restores a missing built-in folder on the next boot.
router.delete('/dj/skills/:slug', requireAdmin, async (req, res) => {
  const slug = req.params.slug;
  if (SEEDED_KINDS.has(slug)) {
    return res.status(400).json({ error: "built-in skills can't be deleted — disable them instead" });
  }
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: `invalid skill name: ${slug}` });
  }
  if (!(await skillFileExists(slug))) {
    return res.status(404).json({ error: `no such custom skill: ${slug}` });
  }
  try {
    await rm(join(SKILLS_DIR, slug), { recursive: true, force: true });
    await loadSkills();
    syncSkillCrons();
    queue.log('scheduler', `[skills] custom "${slug}" deleted via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err) {
    queue.log('error', `DELETE /dj/skills/${slug} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Manual voice DJ. mode 'raw' speaks text verbatim, 'styled' has the LLM write it
// in persona first. `sfx` airs under the opening words and, being a manual
// trigger, ignores the settings.sfx.enabled autonomy toggle.
router.post('/dj/say', requireAdmin, async (req, res) => {
  const text = (typeof req.body?.text === 'string' ? req.body.text : '').trim().slice(0, SAY_TEXT_MAX);
  if (!text) return res.status(400).json({ error: 'text is required' });

  const kind = SAY_KINDS.includes(req.body?.kind) ? req.body.kind : 'dj-speak';
  const mode = req.body?.mode === 'styled' ? 'styled' : 'raw';

  // Validate up front so a typo is a 400, not a silent no-op inside playSfx
  // after the voice has already been rendered.
  const sfxName = (typeof req.body?.sfx === 'string' ? req.body.sfx : '').trim();
  if (sfxName && !(await sfxLib.getPath(sfxName))) {
    const names = (await sfxLib.list()).map(e => e.name).join(', ');
    return res.status(400).json({ error: `unknown sound effect: ${sfxName}${names ? `. Available: ${names}` : ''}` });
  }

  try {
    let spoken = text;
    if (mode === 'styled') {
      spoken = await dj.generateAdLib({
        instruction: text,
        context: await getFullContext(),
        recap: queue.getDjRecap(),
        recentOpeners: queue.getRecentOpeners(),
      });
    }
    await queue.announce(spoken, kind);
    if (sfxName) void queue.playSfx(sfxName, { underVoice: true });
    res.json({ ok: true, mode, kind, spoken, sfx: sfxName || null });
  } catch (err) {
    queue.log('error', `/dj/say failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Fire a voice segment on demand.
const SEGMENTS = {
  'station-id': runStationId,
  hourly: runHourlyCheck,
  link: runLink,
  // Needs a show with guests on air; ignores the show's banter toggle.
  banter: runBanter,
  // Need a programme show on air; bypass the listener/budget gates and the
  // beat-already-aired flags like every manual trigger.
  'programme-intro': runProgrammeIntro,
  'programme-feature': runProgrammeFeature,
  'programme-outro': runProgrammeOutro,
};

router.post('/dj/segment', requireAdmin, async (req, res) => {
  const type = req.body?.type;
  const run = SEGMENTS[type];
  if (!run) {
    return res.status(400).json({ error: `type must be one of: ${Object.keys(SEGMENTS).join(', ')}` });
  }
  try {
    const spoken = await run();
    res.json({ ok: true, type, spoken });
  } catch (err) {
    queue.log('error', `/dj/segment ${type} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Run a named skill on demand (operator override).
router.post('/dj/skill', requireAdmin, async (req, res) => {
  const name = req.body?.name;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    // `aired: false` is a 200, not an error: the skill ran and had nothing worth
    // saying (#1412), and the operator gets the reason.
    const run = await runCapability(name, await getFullContext());
    res.json({
      ok: true,
      name,
      aired: run.aired,
      queued: run.queued,
      deferred: run.deferred,
      spoken: run.text,
      reason: run.reason,
    });
  } catch (err) {
    queue.log('error', `/dj/skill ${name} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Rebuild the Liquidsoap fallback auto-playlist now.
router.post('/dj/refresh-playlist', requireAdmin, async (req, res) => {
  try {
    await refreshAutoPlaylist();
    res.json({ ok: true });
  } catch (err) {
    queue.log('error', `/dj/refresh-playlist failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Toggle between-track DJ links (mirrors POST /auto-pick).
router.post('/dj/auto-link', requireAdmin, (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoLink = req.body.on;
  queue.log('scheduler', `auto-link ${queue.autoLink ? 'enabled' : 'disabled'}`);
  res.json({ autoLink: queue.autoLink });
});

// Force-end the current track. Admin-only: there is no listener-facing skip.
// Commits the queued pick first (#1300) so the skip airs what the admin queue
// shows as next rather than an auto.m3u fill; the response says which happened.
router.post('/dj/skip', requireAdmin, async (req, res) => {
  try {
    const prep = await queue.commitBeforeSkip();
    await skipTrack();
    if (prep.pending && !prep.committed) {
      queue.log('scheduler', `track skipped by operator — queued pick not confirmed in dj_queue after ${Math.round(prep.waitedMs / 1000)}s; the auto playlist may fill the slot first`);
    } else {
      queue.log('scheduler', 'track skipped by operator');
    }
    res.json({ ok: true, pending: prep.pending, committed: prep.committed });
  } catch (err) {
    queue.log('error', `/dj/skip failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Remove a not-yet-aired track. 409 once it has left Liquidsoap's dj_queue (that
// is /dj/skip territory). Admin-only, mirroring skip.
router.delete('/dj/queue/:trackId', requireAdmin, async (req, res) => {
  try {
    const result = await queue.removeUpcoming(req.params.trackId);
    if (!result.ok) {
      const msg = result.reason === 'already-playing'
        ? 'too late to cancel — the track already left the queue'
        : 'track is not in the queue';
      return res.status(409).json({ error: msg, reason: result.reason });
    }
    res.json({ removed: true });
  } catch (err) {
    queue.log('error', `/dj/queue remove failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// Queue-ready admin row: Subsonic song + the library index's tags and analysis
// columns (the index is the only source of either).
function toAdminRow(s: AdminSong) {
  const tag = library.get(s.id);
  // Match the SOURCE song, not the row below: the row drops albumId/artistId,
  // demoting an album/artist block to its normalised-name fallback.
  const blocked = blocklist.matchOf(s);
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    year: s.year ?? null,
    originalYear: tag?.originalYear ?? null,
    originalYearSource: tag?.originalYearSource ?? null,
    isCompilation: tag?.isCompilation ?? null,
    eraUntrusted: tag?.eraUntrusted ?? null,
    genre: s.genre ?? null,
    duration: s.duration ?? null,
    // Lets getLocalPath() use the on-disk file when MUSIC_LIBRARY_PATH is mounted.
    path: s.path ?? null,
    // Deliberately NOT `?? null`: an absent key drops out of the JSON round trip
    // and stays undefined, telling applyLoudnessGain to re-fetch the song.
    replayGain: s.replayGain,
    moods: tag?.moods ?? [],
    energy: tag?.energy ?? null,
    source: tag?.source ?? null,
    bpm: tag?.bpm ?? null,
    musicalKey: tag?.musicalKey ?? null,
    loudnessLufs: tag?.loudnessLufs ?? null,
    paceMean: tag?.paceMean ?? null,
    // As /library/browse: [] = analysed, no vocals detected.
    instrumental: isInstrumental(tag?.vocalRanges),
    // /dj/search returns blocked rows on purpose; this is what marks them.
    blockedBy: blocked ? blocklist.refOf(blocked) : null,
  };
}

// Library search for the manual queue UI; limit/offset page through search3.
router.get('/dj/search', requireAdmin, async (req, res) => {
  const q = (typeof req.query?.q === 'string' ? req.query.q : '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const limit = Math.min(Math.max(parseInt(String(req.query?.limit || ''), 10) || 30, 1), 100);
  const offset = Math.max(parseInt(String(req.query?.offset || ''), 10) || 0, 0);
  try {
    await library.load();
    // The operator must still find never-play tracks to review them; queueing
    // one is refused at the queue gate with a 409.
    const songs = await subsonic.search(q, { songCount: limit, songOffset: offset, includeBlocked: true });
    const results = songs.map(toAdminRow);
    // search3 returns no total, so a full page is the only "more" signal.
    res.json({ results, hasMore: results.length === limit });
  } catch (err) {
    queue.log('error', `/dj/search failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Navidrome playlists for the show editor's playlist-anchor multi-select.
router.get('/dj/playlists', requireAdmin, async (_req, res) => {
  try {
    const playlists = await subsonic.getPlaylists();
    const results = (Array.isArray(playlists) ? playlists : []).map((p) => ({
      id: p.id,
      name: p.name,
      songCount: p.songCount ?? null,
    }));
    res.json({ results });
  } catch (err) {
    queue.log('error', `/dj/playlists failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Recently added tracks. Navidrome sorts only albums by recency, so expand the
// newest albums into songs and flatten.
router.get('/dj/recent', requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query?.limit || ''), 10) || 20, 1), 50);
  try {
    await library.load();
    const albums = await subsonic.getRecentlyAddedAlbums({ size: limit });
    // Bounded fan-out: unbounded Promise.all fired ~21 parallel getAlbum calls
    // and tipped a loaded Navidrome into failures (#786).
    const songLists = await mapPool(albums, 5, (a: { id: string }) =>
      subsonic.getAlbum(a.id).catch(() => []),
    );
    const results = songLists.flat().slice(0, limit).map(toAdminRow);
    res.json({ results });
  } catch (err) {
    queue.log('error', `/dj/recent failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Push a /dj/search result to the queue. No DJ intro is generated; an auto-link
// still fires if auto-link is on.
router.post('/dj/queue-track', requireAdmin, async (req, res) => {
  const track = req.body || {};
  if (!track.id || !track.title) {
    return res.status(400).json({ error: 'id and title are required' });
  }
  try {
    // Explicit operator action — bypass the request/AI dedup guard (#619) so a
    // deliberate manual queue always fires, even for an already-queued track.
    //
    // `requestedBy: 'studio'` earns the four air-path exemptions a request has
    // (length cap, show-boundary cut, bed reason, sub-crossfade warning);
    // `operator: true` says it is not a listener waiting in line, so it does
    // not consume a `requests.maxPending` slot. The two are separate questions
    // — see queue.pendingListenerRequests().
    const queuePosition = await queue.push({
      track, requestedBy: 'studio', operator: true, allowDuplicate: true,
    });
    if (queuePosition === -2) {
      // The blocklist is absolute: even manual queueing is refused.
      return res.status(409).json({ error: 'track is on the never-play blocklist — unblock it first (Library → Blocked)' });
    }
    res.json({
      ok: true,
      track: { title: track.title, artist: track.artist || null },
      queuePosition,
    });
  } catch (err) {
    queue.log('error', `/dj/queue-track failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /dj/queue-block — queue a whole album, or a run of tracks by one
// artist, as ONE explicit operator action (#1622 FR 4, Discord ask in #1568).
//
// This is `POST /dj/queue-track` thirty times with the two things doing it by
// hand cannot get right: the record's own running order, and a report of what
// the never-play list refused.
//
// WHAT IS AND IS NOT BYPASSED
// ---------------------------
// Nothing new. Each track goes through `queue.push()` with exactly the two
// opt-outs the single-track route already carries — `allowDuplicate: true` past
// the #619 dedup guard, and `requestedBy: 'studio'`, which is the discriminator
// the #447 length cap, the show-boundary cut (#1574) and the bed's request
// reason (#1465) all read. `picker.albumHours` and the artist guard are PICK
// paths and an operator push reaches neither; the block's presence in
// `upcoming` feeds `queue.recentAlbumKeys`, which is the cooldown doing the
// right thing (the picker will not add more of this record behind the block).
//
// The never-play blocklist is NOT bypassed — absolute, requests included. The
// plan reads `blocklist.hitOf` so the response can NAME each refusal, but the
// refusal itself still happens in `push()`, and a `-2` from it is recorded as a
// skip whether or not the plan predicted it.
//
// `operator: true` keeps the block out of the listener request line — see
// queue.pendingListenerRequests().
// ---------------------------------------------------------------------------

// A block's tracks, plus what to call it. Throws a `{ status, error }` shape
// the route turns into a response.
async function resolveBlockSource(body: QueueBlockBody): Promise<{ songs: BlockSong[]; name: string | null; artist: string | null }> {
  const fail = (status: number, error: string) => Object.assign(new Error(error), { status });

  // A seed track resolves BOTH kinds, because the admin row UI never sees an
  // albumId or an artistId — the same reason POST /library/blocklist resolves
  // from a trackId.
  let seed: any = null;
  if (body.trackId) {
    try { seed = await subsonic.getSong(body.trackId); } catch { /* reported below */ }
    if (!seed) throw fail(404, 'track not found');
  }

  if (body.kind === 'album') {
    const albumId = body.id || seed?.albumId;
    if (!albumId) throw fail(404, 'album not resolvable for this track');

    const songs: BlockSong[] = await subsonic.getAlbum(albumId);
    if (!songs.length) throw fail(404, 'that album has no tracks in the library');
    // Read the title off the RECORD rather than the seed: an `id` caller sent
    // no seed at all, and a track's own `album` tag can differ from its
    // siblings' on a badly tagged rip.
    return { songs, name: songs[0]?.album ?? seed?.album ?? null, artist: songs[0]?.artist ?? seed?.artist ?? null };
  }

  // getTopSongs is keyed by NAME, so an id has to be resolved to one first.
  let name = body.artist || seed?.artist || null;
  if (!name && body.id) {
    try { name = (await subsonic.getArtist(body.id))?.name ?? null; } catch { /* reported below */ }
  }
  // Named for what the caller actually sent: an `id` caller supplied no track,
  // and "not resolvable for this track" reads as a bug report about a track
  // that was never in the request.
  if (!name) throw fail(404, seed ? 'artist not resolvable for this track' : 'artist not found');

  // Always ask for the full cap rather than the caller's `limit`: blocked
  // tracks are dropped by the plan, and fetching only `limit` would let two
  // never-play entries silently shorten the block instead of the next two
  // tracks taking their place.
  let songs: BlockSong[] = [];
  try { songs = await subsonic.getTopSongs(name, { count: QUEUE_BLOCK_MAX_TRACKS }); } catch { /* fall through */ }
  if (!songs.length) {
    // getTopSongs is Last.fm-ranked and comes back EMPTY for an artist with no
    // coverage — which is most of a niche catalogue, i.e. exactly the libraries
    // #618 was measured on. Without this fallback the feature is dead there.
    try { songs = await subsonic.getRecentSongsByArtist(name, { albums: 5, count: QUEUE_BLOCK_MAX_TRACKS }); } catch { /* reported below */ }
  }
  if (!songs.length) throw fail(404, `nothing by "${name}" in the library`);
  return { songs, name, artist: name };
}

router.post(
  '/dj/queue-block',
  requireAdmin,
  // verbatim: every message in queueBlockSchema names its own field, so the
  // default dotted-path prefix would double the location — the same narrow
  // exception POST /library/blocklist/rules takes.
  validateBody(queueBlockSchema, { messages: 'verbatim' }),
  async (req, res) => {
    const body = req.body as QueueBlockBody;
    try {
      await library.load();
      const { songs, name, artist } = await resolveBlockSource(body);

      const label = blockLabel({ kind: body.kind, name, artist });
      const plan = planBlock<BlockSong>({
        kind: body.kind,
        songs,
        order: body.order,
        limit: body.kind === 'artist' ? (body.limit ?? QUEUE_BLOCK_ARTIST_LIMIT_DEFAULT) : null,
        // Matched against the SOURCE song, not a projection of it: the row
        // shape drops albumId/artistId, which would demote an album or artist
        // block to its normalised-name fallback (the same note toAdminRow
        // carries).
        hitOf: (song) => blocklist.hitOf(song),
      });

      if (!plan.tracks.length) {
        return res.status(409).json({
          error: plan.skipped.length
            ? `every track on "${label}" is on the never-play blocklist — unblock it first (Library → Blocked)`
            : `nothing playable in "${label}"`,
          skipped: plan.skipped,
        });
      }

      const blockId = randomUUID();
      const skipped = [...plan.skipped];
      let queued = 0;
      let queuePosition: number | null = null;
      for (const track of plan.tracks) {
        // The blocklist verdict is re-read at the push, not carried from the
        // plan: a seasonal rule can turn between the two, and push() is the
        // gate either way.
        const hit = blocklist.hitOf(track);
        const pos = await queue.push({
          track,
          requestedBy: 'studio',
          operator: true,
          allowDuplicate: true,
          block: { id: blockId, label, index: queued + 1, size: plan.tracks.length },
        });
        if (pos === -2) {
          skipped.push({
            title: track.title ?? null,
            artist: track.artist ?? null,
            reason: 'blocked',
            blockedBy: hit,
          });
          continue;
        }
        queued++;
        if (queuePosition == null) queuePosition = pos;
      }

      if (!queued) {
        return res.status(409).json({
          error: `every track on "${label}" was refused by the never-play blocklist`,
          skipped,
        });
      }

      // A late blocklist turn can make the real block shorter than the plan, so
      // the badge's denominator is re-stamped from what actually queued — the
      // indices are already the running count and stay contiguous.
      if (queued !== plan.tracks.length) {
        for (const item of queue.upcoming) {
          if (item.block?.id === blockId) item.block.size = queued;
        }
      }

      // Does the block run past the next show change? WARN ONLY (#1622 FR 4):
      // cutting it would contradict "an explicit operator action always fires",
      // and airing the incoming host's mic-pass between two tracks of one album
      // is the worse outcome — so the operator is told and decides. The handover
      // is what this warning is really about: runPickCycle (which airs the
      // mic-pass) only fires when `upcoming` is EMPTY, so a block spanning a
      // boundary holds a pending handoff until it drains, and a long enough one
      // outlives HANDOFF_MAX_AGE_MS.
      //
      // Measured AFTER the pushes, from the first block item's own air forecast
      // rather than from `now` or from the on-air track alone: the block queues
      // behind whatever was already in `upcoming`, and starting the clock too
      // early is the direction that reads as "this fits" when it does not. The
      // span is the PLAYABLE one (music/silence-trim.ts), never the tagged
      // duration — the same two rules resolveBoundaryCut follows.
      let runsPastShowChange: { at: string; show: string | null; bySec: number } | null = null;
      const head = queue.upcoming.find(i => i.block?.id === blockId);
      const totalSec = blockPlayableSec(plan.tracks, (song) => silenceTrim.playableSpanSec(song));
      const startsInSec = head ? queue.airForecastSec(head) : null;
      if (totalSec != null && startsInSec != null) {
        const startMs = Date.now() + Math.max(0, startsInSec) * 1000;
        const boundaryMs = nextShowBoundaryMs(startMs, totalSec);
        if (boundaryMs != null) {
          runsPastShowChange = {
            at: new Date(boundaryMs).toISOString(),
            show: settings.resolveActiveShow(new Date(boundaryMs))?.name ?? null,
            bySec: Math.round((startMs + totalSec * 1000 - boundaryMs) / 1000),
          };
        }
      }

      // ONE booth-log line for the whole press — push() stays silent for block
      // members precisely so this is what the operator reads back.
      queue.log('queued',
        `${body.kind === 'album' ? 'album' : 'artist block'}: ${label} — ${queued} track${queued === 1 ? '' : 's'}`
        + (skipped.length ? `, ${skipped.length} skipped (never-play)` : '')
        + (plan.truncated ? `, ${plan.truncated} over the ${QUEUE_BLOCK_MAX_TRACKS}-track limit` : '')
        + (runsPastShowChange ? `, running ${Math.round(runsPastShowChange.bySec / 60)}min past the next show change` : ''),
        { blockId, kind: body.kind, queued, skipped: skipped.length, truncated: plan.truncated });

      res.json({
        ok: true,
        kind: body.kind,
        blockId,
        label,
        queued,
        queuePosition,
        truncated: plan.truncated,
        skipped,
        runsPastShowChange,
      });
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      queue.log('error', `/dj/queue-block failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /dj/queue/block/:blockId — cancel what remains of a queued block.
//
// The inverse of the one press that queued it: an operator who can put thirty
// tracks on air with one action must be able to take them off with one, and
// pulling twenty-nine rows by hand is the failure this prevents.
//
// PARTIAL SUCCESS IS THE NORMAL ANSWER, not an error — a track Liquidsoap has
// already taken out of dj_queue cannot be cancelled and plays out (that is what
// /dj/skip is for), and on a long block the head very often is exactly that. A
// 200 reporting `removed` and `kept` is honest; a 409 over one committed track
// would leave the operator doing it by hand anyway.
//
// Registration order is not load-bearing here, unlike the blocklist rule
// routes: DELETE /dj/queue/:trackId is ONE path segment and cannot match this
// two-segment path, so a block id can never be read as a track id. Kept beside
// the route that creates a block rather than beside the one it resembles.
// ---------------------------------------------------------------------------
router.delete('/dj/queue/block/:blockId', requireAdmin, async (req, res) => {
  try {
    const result = await queue.removeUpcomingBlock(req.params.blockId);
    if (!result.removed && !result.kept) {
      return res.status(404).json({ error: 'no queued tracks from that block' });
    }
    res.json({ removed: result.removed, kept: result.kept, label: result.label });
  } catch (err) {
    queue.log('error', `/dj/queue block cancel failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /dj/skill-toggle — enable/disable a skill's autonomous firing
// Body: { name, on: true | false }
// Manual /dj/skill firing still works on a disabled skill (operator override).
// ---------------------------------------------------------------------------
router.post('/dj/skill-toggle', requireAdmin, async (req, res) => {
  const name = req.body?.name;
  const on = req.body?.on;
  if (!name || typeof name !== 'string' || typeof on !== 'boolean') {
    return res.status(400).json({ error: 'name (string) and on (boolean) are required' });
  }
  if (!skillCatalog().some(s => s.name === name)) {
    return res.status(400).json({ error: `unknown skill: ${name}` });
  }
  try {
    await settings.update({ skills: { enabled: { [name]: on } } });
    queue.log('scheduler', `skill ${name} ${on ? 'enabled' : 'disabled'}`);
    res.json({ skills: skillCatalog() });
  } catch (err) {
    queue.log('error', `/dj/skill-toggle failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
