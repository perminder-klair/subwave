// Admin-gated DJ command center — the HTTP surface behind /admin/dash.
// Lets the operator step into the autonomous booth: speak custom text on-air,
// fire any voice segment or skill on demand, refresh the auto-playlist, and
// flip the auto-link toggle. Manual triggers are an operator override — they
// bypass the `shouldFire` frequency gate and skill cooldowns.
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

export const router = express.Router();

// Prompt-only skill fields shared by the create/edit routes — structurally the
// SkillFileFields that writeSkillFile (skills/scaffold.ts) consumes.
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

// The knobs a skill declares for itself in tool.mjs (`configFields`). Read off
// the LOADED capability, never off the kind string — that hardcoding is what
// made a renamed copy of News lose its feed field (#1300).
function declaredConfigFields(kind: string): SkillConfigField[] {
  const cap = loadedCapabilities().find(c => c.kind === kind);
  return (cap?.configFields as SkillConfigField[] | undefined) || [];
}

// The skill's own frontmatter as the loader parsed it — the fallback source of
// current knob values when the state SKILL.md can't be read.
function loadedConfig(kind: string): Record<string, string> | null {
  const cap = loadedCapabilities().find(c => c.kind === kind);
  return (cap?.config as Record<string, string> | undefined) || null;
}

// The knob values a save should persist, plus the declared key list that tells
// writeSkillFile which frontmatter lines this form is authoritative for.
//
// Values: prefer the explicit `config` object; accept top-level keys too (the
// pre-#1300 shape, `{ feed, feedMaxItems }`); and when the caller sends neither,
// keep what's already on disk — writeSkillFile rewrites the whole SKILL.md, so a
// line we don't emit is a line we delete. Anything the skill does NOT declare is
// carried through by writeSkillFile's own preserve pass, so a tool.mjs that
// currently fails to import costs its skill a settings form, never its saved
// values. Throws on an invalid value (the routes turn that into a 400).
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
  // Only present on raw Subsonic songs; the never-play match prefers these
  // over the name fallback, so keep them on the way in even though no admin
  // row renders them.
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

// ---------------------------------------------------------------------------
// GET /dj/skills — skill catalogue for the command-center UI
// ---------------------------------------------------------------------------
router.get('/dj/skills', requireAdmin, (req, res) => {
  res.json({ skills: skillCatalog() });
});

// ---------------------------------------------------------------------------
// POST /dj/skills/rescan — reload all skills from state/skills (picks up new
// folders and edited SKILL.md / tool.mjs files — built-in or custom — without a
// controller restart). Returns the refreshed catalogue.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// GET /dj/skills/community — the shipped community catalog (prompt-only skills
// contributed via the community-submission flow, COPYd into the image). Each
// entry is annotated with `installed` (a state/skills folder already exists) and
// `reserved` (its slug shadows a built-in / queue-internal kind, so it can't be
// installed). Browse-only — nothing here airs until the operator installs it.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// POST /dj/skills/community/:slug/install — copy a community catalog skill into
// state/skills/<slug>/SKILL.md so it becomes an ordinary (non-seeded) custom
// skill: editable, deletable, and — like every custom skill — DISABLED on
// arrival (the loader posture), so the operator reviews then enables it. Reuses
// buildCustomSkillFields + writeSkillFile so the on-disk file is byte-identical
// to a locally-authored skill. Rejects reserved names and re-installs (409).
// ---------------------------------------------------------------------------
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
    // Normalize through the same builder the create/edit routes use, so a bad
    // catalog entry (unknown context field, malformed cooldown) fails loudly
    // here rather than writing a skill the loader would later reject.
    fields = buildCustomSkillFields(slug, {
      brief: cs.brief,
      label: cs.label,
      cooldown: cs.cooldown,
      context: cs.context,
      window: cs.window,
      // `cron`/`cronOnly` ride along like every other frontmatter field a
      // catalog entry may declare. They were omitted from this allowlist while
      // the zip-import path (which writes SKILL.md verbatim) kept them, so the
      // two install routes disagreed about a documented key.
      cron: cs.cron,
      cronOnly: cs.cronOnly,
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

// ---------------------------------------------------------------------------
// GET /dj/skills/:slug/export — download a skill as a .zip (SKILL.md + tool.mjs
// if present), files at the archive root. Works for any installed skill —
// built-in or custom — so an operator can hand a skill to another station or
// keep it as a portable backup. Auth-gated, so the browser fetches it via
// adminFetch → blob rather than a plain <a href> (which can't send the header).
// ---------------------------------------------------------------------------
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

// Reject absolute paths and any '..' traversal so a malicious zip can't write
// outside state/skills (mirrors backup.ts isSafeEntry — zip-slip guard).
function isSafeZipEntry(entryName: string): boolean {
  const n = entryName.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').includes('..');
}

// ---------------------------------------------------------------------------
// POST /dj/skills/import — install a skill from an uploaded .zip (the inverse of
// export). The slug is taken from the bundle's SKILL.md `name:` — not the zip
// filename — and validated against the loader's rules. Only SKILL.md + tool.mjs
// are extracted; every entry is zip-slip checked and the bundle is size/entry
// capped. A bundle MAY carry a tool.mjs (this is a direct operator action on
// their own box — same trust as dropping a folder by hand or a backup restore),
// so the imported skill arrives DISABLED and the response flags `hasTool` for a
// "this runs code" warning. Rejects reserved names and re-imports (409).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Custom-skill CRUD helpers. Custom skills live at state/skills/<slug>/SKILL.md
// (prompt-only: frontmatter + the markdown brief). The controller is the single
// validation gate, reusing SLUG_RE / RESERVED_KINDS / dj.CONTEXT_FIELDS so the
// rules never drift from what the loader enforces. tool.mjs stays a disk-drop +
// Rescan power-feature — writeSkillFile never touches it.
// ---------------------------------------------------------------------------
const SKILLS_DIR = resolve(STATE_DIR, 'skills');

// True when SKILL.md exists for this slug (folder is a real skill).
async function skillFileExists(slug: string): Promise<boolean> {
  try { await stat(join(SKILLS_DIR, slug, 'SKILL.md')); return true; } catch { return false; }
}

// True when the custom skill has a tool.mjs data fetcher beside SKILL.md, so the
// edit form can warn that a data tool is attached and edited on disk, not here.
async function skillHasTool(slug: string): Promise<boolean> {
  try { await stat(join(SKILLS_DIR, slug, 'tool.mjs')); return true; } catch { return false; }
}

// Validate the prompt-only fields shared by create + custom-edit, returning a
// SkillFileFields object for writeSkillFile. Throws Error(message) on the first
// invalid field; callers map that to a 400. The slug is the immutable identity,
// passed in (from the URL on edit, from the body on create).
//
// The rules themselves live in the shared skill schema, which the admin editor
// runs too — this is the thin adapter that turns a ZodError into the flat
// message string every caller here already reports.
function buildCustomSkillFields(slug: string, b: unknown): SkillFields {
  const parsed = customSkillFileSchema.safeParse(b);
  if (!parsed.success) throw new Error(firstMessage(parsed.error));
  return skillFieldsFrom(slug, parsed.data);
}

// The other half of the cron check. SKILL_CRON_RE (schemas/skill.ts) can only
// count fields — the shared schema may import nothing but zod — so the range
// rules ("99 * * * *", "* * * * FUNKDAY") are node-cron's to answer, and this
// is the only layer that can ask it.
//
// REFUSED here rather than saved-and-skipped at registration. syncSkillCrons()
// logs and skips an expression it can't register, which is right for a
// hand-edited SKILL.md (a typo must not stop the skill loading) and wrong for
// a form submit: the operator gets a saved value, a green toast, and a station
// that never speaks at the time they asked for. Returns the 400 and true when
// it fires, so a call site reads as one guard line.
function rejectInvalidCron(res: express.Response, fields: SkillFields): boolean {
  const expr = fields.cron;
  if (!expr || cron.validate(expr)) return false;
  const error = `"${expr}" is not a cron expression node-cron can run — check each field's range`;
  res.status(400).json({ error, fieldErrors: { cron: error } });
  return true;
}

// ---------------------------------------------------------------------------
// GET /dj/skills/:kind/file — read a skill's editable SKILL.md so the admin UI
// can prefill its edit form. Serves both the 7 built-in kinds (falling back to
// live defaults when the file hasn't been scaffolded yet) and custom skills
// (404 when there's no such folder).
// ---------------------------------------------------------------------------
router.get('/dj/skills/:kind/file', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  const cat = skillCatalog().find(s => s.kind === kind);
  // Settings the skill declares for ITSELF (news' feed, anything a custom
  // tool.mjs declares) plus their current values — the form renders whatever is
  // here, so a renamed copy keeps its knobs (#1300).
  const configFields = declaredConfigFields(kind);

  if (SEEDED_KINDS.has(kind)) {
    // Shipped defaults read straight from the built-in's TEMPLATE (NOT the live
    // state copy), so the admin "Reset to default" shows the as-shipped brief
    // even after the state SKILL.md has been edited. Knob values are NOT part of
    // this payload — the reset itself is server-side (resetBuiltinSkill re-seeds
    // news' feed from config, env-or-BBC), and the UI only reads `defaults` to
    // decide whether to offer the button.
    const tpl = await readTemplate(kind);
    const defaults = tpl ? {
      label: tpl.data.label || kind,
      cooldown: tpl.data.cooldown || '60m',
      context: (effectiveContextFields({ contextFields: tpl.data.context ?? tpl.data.contextFields }) || []).join(', '),
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
        // Comma-separated "right now" fields this segment may weave in (#471).
        // Prefer the file's own value; fall back to the live effective set.
        context: (data.context ?? data.contextFields)?.trim() || (cat?.contextFields || []).join(', '),
        knownContextFields: [...dj.CONTEXT_FIELDS],
        cron: data.cron?.trim() || null,
        // True when the file carries an expression node-cron won't register —
        // only reachable from a hand-edited SKILL.md, since the save routes
        // refuse one. The scheduler logs it and skips; the editor is where the
        // value is actually fixable, so it needs to say so there too.
        cronInvalid: !!data.cron?.trim() && !cron.validate(data.cron.trim()),
        cronOnly: String(data.cronOnly).trim().toLowerCase() === 'true',
        configFields,
        config: readConfigValues(configFields, data),
        tags: parseTags(data.tags),
        brief: body || cat?.description || '',
        // Built-ins now carry an editable tool.mjs in state too (seeded on first
        // boot), so the edit form shows the same "edit on disk + Rescan" hint as
        // custom skills.
        hasTool: await skillHasTool(kind),
        defaults,
      });
    } catch {
      // No file yet — hand back the live built-in defaults so the form prefills.
      return res.json({
        kind,
        custom: false,
        exists: false,
        label: cat?.label || kind,
        cooldown: msToCooldownStr(cat?.cooldownMs || 0),
        context: (cat?.contextFields || []).join(', '),
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
      // A custom skill carrying a tool.mjs with `configFields` gets the same
      // settings section as a built-in — this is the half that was missing for
      // an exported-and-renamed News skill (#1300).
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
      tags: parseTags(data.tags),
      hasTool: await skillHasTool(kind),
      brief: body || '',
    });
  } catch {
    res.status(404).json({ error: `no such skill: ${kind}` });
  }
});

// ---------------------------------------------------------------------------
// POST /dj/skills — create a custom (prompt-only) skill. Writes a new
// state/skills/<slug>/SKILL.md and reloads. Created skills arrive DISABLED (the
// loader's posture) — the operator reviews + enables them before they can air.
// Body: { name, label?, cooldown?, context?, window?, requiresKey?, brief }
//
// The shape is validated by the shared schema at the boundary; what's left here
// is the two rules a schema can't hold, because both are answers about the live
// install rather than about the value. Both name a FIELD in the error payload:
// the way out of either is to type a different slug.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// PUT /dj/skills/:kind/file — write a skill's SKILL.md from the admin edit form,
// then reload so the change applies immediately. Built-in kinds take the seeded
// path; custom slugs (which must already exist) take the prompt-only path.
// ---------------------------------------------------------------------------
router.put('/dj/skills/:kind/file', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  const b = req.body || {};

  // Custom skill edit — same validation as create, minus the slug (immutable).
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
      // Knobs the skill's own tool.mjs declares. Without this the rewrite below
      // would drop them: an imported+renamed News skill lost its `feed:` line on
      // the first save from the admin form (#1300).
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

  // Built-in edit — brief/cooldown/label/context, + any knobs its tool declares.
  // Same schema as a custom skill minus `window` / `requiresKey`, which a
  // built-in takes from its shipped template and this route has never read off
  // the body. This branch used to be a 35-line copy of buildCustomSkillFields.
  const parsed = builtinSkillFileSchema.safeParse(b);
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error) });
  const fields: SkillFields = skillFieldsFrom(kind, parsed.data);
  if (rejectInvalidCron(res, fields)) return;

  // Knobs the skill declares for itself (news' feed / feedMaxItems), validated
  // against that declaration rather than against the kind string. Read off the
  // RAW body, not the parsed one: the declaration is runtime data from tool.mjs,
  // so a skill-file body is not a closed shape and the schema above deliberately
  // doesn't try to own its tail.
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

// ---------------------------------------------------------------------------
// PUT /dj/skills/:slug/personas — reverse assignment: set exactly which DJs run
// this skill, from the skill's own editor (instead of persona-by-persona in
// PersonaSkillsCard — both write the same personas[].skills field).
// Body: { personaIds: string[] } — the personas that SHOULD have the skill.
// The read-modify-write happens server-side so the null sentinel ("all skills")
// is interpreted in exactly one place: null + assigned → stays null (already
// covered); null + unassigned → materialises the full current catalog minus
// this skill (what un-ticking the first box in PersonaSkillsCard does too).
// ---------------------------------------------------------------------------
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
    // `== null` covers BOTH the explicit "all skills" sentinel and an ABSENT
    // key: the seeded roster (SEED_PERSONAS) carries no `skills` at all until
    // the operator saves personas once, and everything else that reads this
    // field already treats falsy as "runs everything" (skills/_agent.ts's
    // `persona?.skills &&` gate, the admin panel's personaHasSkill). A strict
    // `=== null` here threw `Cannot read properties of undefined` on a fresh
    // station, so ticking a DJ in a skill's editor hung the request.
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

// ---------------------------------------------------------------------------
// POST /dj/skills/:kind/reset — restore a built-in to its shipped default,
// overwriting BOTH state/skills/<kind>/SKILL.md AND tool.mjs from the image
// template. This is how an operator reverts a broken edit or pulls in a newer
// image's tool.mjs (which the seeder won't auto-apply once the file exists).
// Only valid for seeded built-in kinds — custom skills have no shipped default.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// DELETE /dj/skills/:slug — remove a custom skill (its whole folder, including
// any tool.mjs). Built-ins can't be deleted — only disabled; the seeder restores
// a missing built-in folder on the next boot. Reloads and returns the catalogue.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// POST /dj/say — manual voice DJ
// Body: { text, kind?: 'dj-speak'|'link', mode?: 'raw'|'styled', sfx?: string }
//   raw    → the DJ speaks `text` verbatim
//   styled → `text` is an instruction; the LLM writes it in persona, then speaks
//   sfx    → a library effect aired under the opening words (attention stinger
//            for e.g. emergency announcements). Manual trigger — ignores the
//            settings.sfx.enabled autonomy toggle like every operator press.
// ---------------------------------------------------------------------------
router.post('/dj/say', requireAdmin, async (req, res) => {
  const text = (typeof req.body?.text === 'string' ? req.body.text : '').trim().slice(0, SAY_TEXT_MAX);
  if (!text) return res.status(400).json({ error: 'text is required' });

  const kind = SAY_KINDS.includes(req.body?.kind) ? req.body.kind : 'dj-speak';
  const mode = req.body?.mode === 'styled' ? 'styled' : 'raw';

  // Validate the effect name up front so a typo is a 400 naming the catalogue,
  // not a silent no-op inside playSfx after the voice is already rendered.
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

// ---------------------------------------------------------------------------
// POST /dj/segment — fire a voice segment on demand
// Body: { type: 'station-id' | 'hourly' | 'link' | 'banter'
//         | 'programme-intro' | 'programme-feature' | 'programme-outro' }
// ---------------------------------------------------------------------------
const SEGMENTS = {
  'station-id': runStationId,
  hourly: runHourlyCheck,
  link: runLink,
  // Multi-voice guest exchange. Needs a show with guests on air (the runner
  // throws a clear error otherwise); ignores the show's banter toggle — an
  // explicit operator press always fires.
  banter: runBanter,
  // Programme episode beats. Need a programme show on air (the runners throw
  // a clear error otherwise); like every manual trigger they bypass the
  // listener/budget gates and the beat-already-aired flags.
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

// ---------------------------------------------------------------------------
// POST /dj/skill — run a named skill on demand (operator override)
// Body: { name }
// ---------------------------------------------------------------------------
router.post('/dj/skill', requireAdmin, async (req, res) => {
  const name = req.body?.name;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    // `aired: false` is a 200, not an error: the skill ran, looked at what it
    // fetched, and had nothing worth saying (issue #1412). The operator gets
    // the reason — the alternative was a fabricated line or an opaque 500.
    const run = await runCapability(name, await getFullContext());
    res.json({ ok: true, name, aired: run.aired, spoken: run.text, reason: run.reason });
  } catch (err) {
    queue.log('error', `/dj/skill ${name} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /dj/refresh-playlist — rebuild the Liquidsoap fallback auto-playlist now
// ---------------------------------------------------------------------------
router.post('/dj/refresh-playlist', requireAdmin, async (req, res) => {
  try {
    await refreshAutoPlaylist();
    res.json({ ok: true });
  } catch (err) {
    queue.log('error', `/dj/refresh-playlist failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /dj/auto-link — toggle between-track DJ links (mirrors POST /auto-pick)
// Body: { on: true | false }
// ---------------------------------------------------------------------------
router.post('/dj/auto-link', requireAdmin, (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoLink = req.body.on;
  queue.log('scheduler', `auto-link ${queue.autoLink ? 'enabled' : 'disabled'}`);
  res.json({ autoLink: queue.autoLink });
});

// ---------------------------------------------------------------------------
// POST /dj/skip — force-end the current track (operator override)
// There is no listener-facing skip by design; this is admin-gated only.
// Commits the queued pick to dj_queue first (queue.commitBeforeSkip, #1300
// bug 6) so the skip airs what the admin queue shows as next, not a random
// auto.m3u fill — the response says which of the two actually happened.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// DELETE /dj/queue/:trackId — remove a not-yet-aired track from the upcoming
// queue (operator override). Refuses with 409 once the track has left
// Liquidsoap's dj_queue (it's on air or about to be) — that's /dj/skip
// territory. Listeners can't reach this; there is no listener-facing cancel
// by design, mirroring skip.
// ---------------------------------------------------------------------------
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

// Shape a Subsonic song into the queue-ready row the admin track tabs render,
// merging the library index's stored tags AND acoustic-analysis columns so
// search/recent rows carry the same mood/energy + BPM/key/LUFS badges as
// browse rows (the index is the only source of either — Subsonic metadata
// carries none).
function toAdminRow(s: AdminSong) {
  const tag = library.get(s.id);
  // Matched against the SOURCE song, not the row below: the row drops
  // albumId/artistId, which would demote an album/artist block to its
  // normalised-name fallback.
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
    // path lets getLocalPath() use the on-disk file when MUSIC_LIBRARY_PATH
    // is mounted, matching how listener-requested tracks are queued.
    path: s.path ?? null,
    // Rides back through POST /dj/queue-track so a manually queued track gets
    // the same ReplayGain-first loudness resolution as picker/request tracks.
    // Deliberately NOT `?? null`: an absent key drops out of the JSON round
    // trip and stays undefined, which tells applyLoudnessGain to re-fetch the
    // song rather than trusting that the tag is really missing.
    replayGain: s.replayGain,
    moods: tag?.moods ?? [],
    energy: tag?.energy ?? null,
    source: tag?.source ?? null,
    bpm: tag?.bpm ?? null,
    musicalKey: tag?.musicalKey ?? null,
    loudnessLufs: tag?.loudnessLufs ?? null,
    paceMean: tag?.paceMean ?? null,
    // Same derivation as /library/browse: [] = analysed, no vocals detected.
    instrumental: tag?.vocalRanges == null ? null : tag.vocalRanges.length === 0,
    // Which never-play entry keeps this row off the air, or null. /dj/search
    // returns blocked rows on purpose (the operator has to be able to find one
    // to review it) — this is what tells them apart on screen.
    blockedBy: blocked ? blocklist.refOf(blocked) : null,
  };
}

// ---------------------------------------------------------------------------
// GET /dj/search?q=<terms>&limit=&offset= — library search for the manual
// queue UI. limit/offset page through Subsonic's search3 (songOffset), so the
// admin Search tab can "Load more" past the first page.
// ---------------------------------------------------------------------------
router.get('/dj/search', requireAdmin, async (req, res) => {
  const q = (typeof req.query?.q === 'string' ? req.query.q : '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const limit = Math.min(Math.max(parseInt(String(req.query?.limit || ''), 10) || 30, 1), 100);
  const offset = Math.max(parseInt(String(req.query?.offset || ''), 10) || 0, 0);
  try {
    await library.load();
    // includeBlocked: the operator must still find never-play tracks here to
    // review them; queueing one is refused at the queue gate with a clear 409.
    const songs = await subsonic.search(q, { songCount: limit, songOffset: offset, includeBlocked: true });
    const results = songs.map(toAdminRow);
    // A full page means there may be more — the UI shows Load more on this
    // rather than a total (search3 doesn't return one).
    res.json({ results, hasMore: results.length === limit });
  } catch (err) {
    queue.log('error', `/dj/search failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /dj/playlists — the operator's Navidrome playlists, for the show editor's
// playlist-anchor multi-select. id + name + songCount is all the UI needs.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// GET /dj/recent — most recently added tracks, for the manual queue UI.
// Navidrome only sorts albums by recency, so we expand the newest albums into
// their songs and flatten. Results are queue-ready /dj/search-shaped objects.
// ---------------------------------------------------------------------------
router.get('/dj/recent', requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query?.limit || ''), 10) || 20, 1), 50);
  try {
    await library.load();
    const albums = await subsonic.getRecentlyAddedAlbums({ size: limit });
    // Bounded fan-out: an unbounded Promise.all fired one getAlbum per album
    // (~21 parallel Navidrome calls at the default limit), which tipped a
    // slow/loaded Navidrome into failures (#786). 5-wide keeps it snappy
    // without the thundering herd.
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

// ---------------------------------------------------------------------------
// POST /dj/queue-track — push a specific track to the queue (operator pick)
// Body: { id, title, artist, album, year?, genre? } — a /dj/search result.
// No DJ intro is generated; an auto-link still fires if auto-link is on.
// ---------------------------------------------------------------------------
router.post('/dj/queue-track', requireAdmin, async (req, res) => {
  const track = req.body || {};
  if (!track.id || !track.title) {
    return res.status(400).json({ error: 'id and title are required' });
  }
  try {
    // Explicit operator action — bypass the request/AI dedup guard (#619) so a
    // deliberate manual queue always fires, even for an already-queued track.
    const queuePosition = await queue.push({ track, requestedBy: 'studio', allowDuplicate: true });
    if (queuePosition === -2) {
      // The never-play blocklist is absolute — even manual queueing is refused
      // (operator's call). Unblock in admin → Library → Blocked to re-audition.
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
