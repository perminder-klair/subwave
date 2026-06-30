// Admin-gated DJ command center — the HTTP surface behind /admin/dash.
// Lets the operator step into the autonomous booth: speak custom text on-air,
// fire any voice segment or skill on demand, refresh the auto-playlist, and
// flip the auto-link toggle. Manual triggers are an operator override — they
// bypass the `shouldFire` frequency gate and skill cooldowns.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { queue } from '../broadcast/queue.js';
import * as dj from '../llm/dj.js';
import * as subsonic from '../music/subsonic.js';
import * as library from '../music/library.js';
import * as settings from '../settings.js';
import { runStationId, runHourlyCheck, runLink, refreshAutoPlaylist } from '../broadcast/scheduler.js';
import { skillCatalog, runCapability, effectiveContextFields } from '../skills/_agent.js';
import { loadSkills, parseFrontmatter, SEEDED_KINDS, RESERVED_KINDS, SLUG_RE, readTemplate } from '../skills/loader.js';
import { writeSkillFile, msToCooldownStr, resetBuiltinSkill } from '../skills/scaffold.js';
import { readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STATE_DIR, config } from '../config.js';
import { skipTrack } from '../broadcast/liquidsoap-control.js';
import { getFullContext } from '../context.js';

export const router = express.Router();

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
    queue.log('scheduler', `[skills] rescanned — ${caps.length} skill(s) loaded`);
    res.json({ skills: skillCatalog(), custom: caps.filter((c: any) => !c.seeded).length });
  } catch (err) {
    queue.log('error', `/dj/skills/rescan failed: ${err.message}`);
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
const COOLDOWN_RE = /^\d+\s*[smhd]?$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

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
function buildCustomSkillFields(slug: string, b: any): any {
  const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
  if (!brief) throw new Error('brief is required');

  const cooldown = typeof b.cooldown === 'string' ? b.cooldown.trim() : '';
  if (cooldown && !COOLDOWN_RE.test(cooldown)) {
    throw new Error('cooldown must look like "45m", "6h", "2d", or a bare number (minutes)');
  }

  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : undefined;
  const fields: any = { kind: slug, label, cooldown: cooldown || undefined, brief };

  // Context fields — the "right now" lines this segment may weave in (#471).
  // Accept a comma string or an array; validate every token so a typo fails
  // loudly here. An empty selection resets the skill to the default profile.
  if (b.context !== undefined) {
    const raw = Array.isArray(b.context) ? b.context : String(b.context).split(',');
    const toks = raw.map((s: any) => String(s).trim().toLowerCase()).filter(Boolean);
    const known = new Set<string>(dj.CONTEXT_FIELDS as readonly string[]);
    const bad = toks.filter((t: string) => !known.has(t));
    if (bad.length) {
      throw new Error(`unknown context field(s): ${bad.join(', ')} — valid: ${[...known].join(', ')}`);
    }
    if (toks.length) fields.contextFields = toks;
  }

  if (b.window !== undefined) {
    const w = String(b.window).trim().toLowerCase();
    if (w !== 'any' && w !== 'commute') throw new Error('window must be "any" or "commute"');
    if (w === 'commute') fields.window = 'commute';
  }

  if (b.requiresKey !== undefined && String(b.requiresKey).trim()) {
    const key = String(b.requiresKey).trim();
    if (!ENV_KEY_RE.test(key)) throw new Error('requiresKey must be an env var name (UPPER_SNAKE_CASE)');
    fields.requiresKey = key;
  }

  return fields;
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

  if (SEEDED_KINDS.has(kind)) {
    // Shipped defaults read straight from the built-in's TEMPLATE (NOT the live
    // state copy), so the admin "Reset to default" shows the as-shipped brief
    // even after the state SKILL.md has been edited. News seeds its feed from
    // config (env-or-BBC), mirroring the seeder.
    const tpl = await readTemplate(kind);
    const defaults = tpl ? {
      label: tpl.data.label || kind,
      cooldown: tpl.data.cooldown || '60m',
      context: (effectiveContextFields({ contextFields: tpl.data.context ?? tpl.data.contextFields }) || []).join(', '),
      brief: tpl.body || '',
      ...(kind === 'news' ? { feed: config.news.feedUrl, feedMaxItems: config.news.maxItems } : {}),
    } : null;

    const file = join(SKILLS_DIR, kind, 'SKILL.md');
    try {
      const raw = await readFile(file, 'utf8');
      const { data, body } = parseFrontmatter(raw);
      return res.json({
        kind,
        custom: false,
        exists: true,
        isNews: kind === 'news',
        label: data.label || cat?.label || kind,
        cooldown: data.cooldown || msToCooldownStr(cat?.cooldownMs || 0),
        // Comma-separated "right now" fields this segment may weave in (#471).
        // Prefer the file's own value; fall back to the live effective set.
        context: (data.context ?? data.contextFields)?.trim() || (cat?.contextFields || []).join(', '),
        knownContextFields: [...dj.CONTEXT_FIELDS],
        feed: data.feed || cat?.feed || null,
        feedMaxItems: data.feedMaxItems ? parseInt(data.feedMaxItems, 10) : (cat?.feedMaxItems || null),
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
        isNews: kind === 'news',
        label: cat?.label || kind,
        cooldown: msToCooldownStr(cat?.cooldownMs || 0),
        context: (cat?.contextFields || []).join(', '),
        knownContextFields: [...dj.CONTEXT_FIELDS],
        feed: cat?.feed || null,
        feedMaxItems: cat?.feedMaxItems || null,
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
      isNews: false,
      label: data.label || cat?.label || kind,
      cooldown: data.cooldown || (cat?.cooldownMs ? msToCooldownStr(cat.cooldownMs) : ''),
      context: (data.context ?? data.contextFields)?.trim() || (cat?.contextFields || []).join(', '),
      knownContextFields: [...dj.CONTEXT_FIELDS],
      window: data.window === 'commute' ? 'commute' : 'any',
      requiresKey: data.requiresKey || '',
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
// ---------------------------------------------------------------------------
router.post('/dj/skills', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim().toLowerCase() : '';
  if (!SLUG_RE.test(name)) {
    return res.status(400).json({ error: 'name must be a lowercase slug (a–z, 0–9, hyphens), 1–49 chars' });
  }
  if (RESERVED_KINDS.has(name)) {
    return res.status(400).json({ error: `"${name}" is reserved — it shadows a built-in capability, pick another name` });
  }
  if (await skillFileExists(name)) {
    return res.status(409).json({ error: `a skill named "${name}" already exists` });
  }

  let fields: any;
  try {
    fields = buildCustomSkillFields(name, b);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    await writeSkillFile(fields);
    await loadSkills();
    queue.log('scheduler', `[skills] custom "${name}" created via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err: any) {
    queue.log('error', `POST /dj/skills (${name}) failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /dj/skills/:kind/file — write a skill's SKILL.md from the admin edit form,
// then reload so the change applies immediately. Built-in kinds take the news-
// aware path; custom slugs (which must already exist) take the prompt-only path.
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
    let fields: any;
    try {
      fields = buildCustomSkillFields(kind, b);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    try {
      await writeSkillFile(fields); // rewrites SKILL.md only; a sibling tool.mjs is left intact
      await loadSkills();
      queue.log('scheduler', `[skills] custom "${kind}" edited via admin UI`);
      return res.json({ skills: skillCatalog() });
    } catch (err: any) {
      queue.log('error', `PUT /dj/skills/${kind}/file failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // Built-in edit — brief/cooldown/label/context, + feed/feedMaxItems for news.
  const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
  if (!brief) return res.status(400).json({ error: 'brief is required' });

  const cooldown = typeof b.cooldown === 'string' ? b.cooldown.trim() : '';
  if (cooldown && !COOLDOWN_RE.test(cooldown)) {
    return res.status(400).json({ error: 'cooldown must look like "45m", "6h", "2d", or a bare number (minutes)' });
  }

  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : undefined;
  const fields: any = { kind, label, cooldown: cooldown || undefined, brief };

  // Context fields — the "right now" lines this segment may weave in (#471).
  // Accept a comma string or an array; validate every token against the known
  // vocabulary so a typo fails loudly here instead of silently narrowing the
  // block. An empty selection resets the skill to the default profile.
  if (b.context !== undefined) {
    const raw = Array.isArray(b.context) ? b.context : String(b.context).split(',');
    const toks = raw.map((s: any) => String(s).trim().toLowerCase()).filter(Boolean);
    const known = new Set<string>(dj.CONTEXT_FIELDS as readonly string[]);
    const bad = toks.filter((t: string) => !known.has(t));
    if (bad.length) {
      return res.status(400).json({ error: `unknown context field(s): ${bad.join(', ')} — valid: ${[...known].join(', ')}` });
    }
    if (toks.length) fields.contextFields = toks;
  }

  // Feed is news-only. Validate it parses as an http(s) URL.
  if (kind === 'news') {
    const feed = typeof b.feed === 'string' ? b.feed.trim() : '';
    if (feed) {
      try {
        const u = new URL(feed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      } catch {
        return res.status(400).json({ error: 'feed must be an http(s) URL' });
      }
      fields.feed = feed;
    }
    const max = parseInt(b.feedMaxItems, 10);
    if (Number.isFinite(max) && max > 0) fields.feedMaxItems = max;
  }

  try {
    await writeSkillFile(fields);
    await loadSkills();
    queue.log('scheduler', `[skills] built-in "${kind}" edited via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err: any) {
    queue.log('error', `PUT /dj/skills/${kind}/file failed: ${err.message}`);
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
    queue.log('scheduler', `[skills] built-in "${kind}" reset to default via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err: any) {
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
    queue.log('scheduler', `[skills] custom "${slug}" deleted via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err: any) {
    queue.log('error', `DELETE /dj/skills/${slug} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /dj/say — manual voice DJ
// Body: { text, kind?: 'dj-speak'|'link', mode?: 'raw'|'styled' }
//   raw    → the DJ speaks `text` verbatim
//   styled → `text` is an instruction; the LLM writes it in persona, then speaks
// ---------------------------------------------------------------------------
router.post('/dj/say', requireAdmin, async (req, res) => {
  const text = (typeof req.body?.text === 'string' ? req.body.text : '').trim().slice(0, SAY_TEXT_MAX);
  if (!text) return res.status(400).json({ error: 'text is required' });

  const kind = SAY_KINDS.includes(req.body?.kind) ? req.body.kind : 'dj-speak';
  const mode = req.body?.mode === 'styled' ? 'styled' : 'raw';

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
    res.json({ ok: true, mode, kind, spoken });
  } catch (err) {
    queue.log('error', `/dj/say failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /dj/segment — fire a voice segment on demand
// Body: { type: 'station-id' | 'hourly' | 'link' }
// ---------------------------------------------------------------------------
const SEGMENTS = {
  'station-id': runStationId,
  hourly: runHourlyCheck,
  link: runLink,
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
    const spoken = await runCapability(name, await getFullContext());
    res.json({ ok: true, name, spoken });
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
// ---------------------------------------------------------------------------
router.post('/dj/skip', requireAdmin, async (req, res) => {
  try {
    await skipTrack();
    queue.log('scheduler', 'track skipped by operator');
    res.json({ ok: true });
  } catch (err) {
    queue.log('error', `/dj/skip failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /dj/search?q=<terms> — library search for the manual queue UI
// ---------------------------------------------------------------------------
router.get('/dj/search', requireAdmin, async (req, res) => {
  const q = (typeof req.query?.q === 'string' ? req.query.q : '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    await library.load();
    const songs = await subsonic.search(q, { songCount: 12 });
    const results = songs.map(s => {
      const tag = library.get(s.id);
      return {
        id: s.id,
        title: s.title,
        artist: s.artist,
        album: s.album,
        year: s.year ?? null,
        genre: s.genre ?? null,
        duration: s.duration ?? null,
        // path lets getLocalPath() use the on-disk file when MUSIC_LIBRARY_PATH
        // is mounted, matching how listener-requested tracks are queued.
        path: s.path ?? null,
        // Merge stored tags so the admin table shows real mood/energy status
        // instead of "needs tags" for every row (the index is the only other
        // source of tags — Subsonic metadata carries none).
        moods: tag?.moods ?? [],
        energy: tag?.energy ?? null,
        source: tag?.source ?? null,
      };
    });
    res.json({ results });
  } catch (err) {
    queue.log('error', `/dj/search failed: ${err.message}`);
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
    const songLists = await Promise.all(
      albums.map((a: any) => subsonic.getAlbum(a.id).catch(() => [])),
    );
    const results = songLists.flat().slice(0, limit).map((s: any) => {
      const tag = library.get(s.id);
      return {
        id: s.id,
        title: s.title,
        artist: s.artist,
        album: s.album,
        year: s.year ?? null,
        genre: s.genre ?? null,
        duration: s.duration ?? null,
        path: s.path ?? null,
        // Merge stored tags so recently-added tracks that are already tagged
        // show their mood/energy instead of a misleading "needs tags".
        moods: tag?.moods ?? [],
        energy: tag?.energy ?? null,
        source: tag?.source ?? null,
      };
    });
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
