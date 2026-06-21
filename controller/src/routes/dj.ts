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
import { skillCatalog, runCapability } from '../skills/_agent.js';
import { loadCustomSkills, parseFrontmatter, BUILTIN_KINDS } from '../skills/loader.js';
import { writeBuiltinSkillFile, msToCooldownStr } from '../skills/scaffold.js';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STATE_DIR } from '../config.js';
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
// POST /dj/skills/rescan — reload operator-dropped custom skills from
// state/skills (picks up new folders and edited SKILL.md / tool.mjs files
// without a controller restart). Returns the refreshed catalogue.
// ---------------------------------------------------------------------------
router.post('/dj/skills/rescan', requireAdmin, async (req, res) => {
  try {
    const caps = await loadCustomSkills();
    queue.log('scheduler', `[skills] rescanned — ${caps.length} custom skill(s) loaded`);
    res.json({ skills: skillCatalog(), custom: caps.length });
  } catch (err) {
    queue.log('error', `/dj/skills/rescan failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /dj/skills/:kind/file — read a built-in skill's editable SKILL.md so the
// admin UI can prefill its edit form. Scoped to the 7 built-in kinds; custom
// skills are edited on disk + Rescan, not here. Falls back to live defaults
// (skillCatalog) when the file hasn't been scaffolded yet.
// ---------------------------------------------------------------------------
router.get('/dj/skills/:kind/file', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  if (!BUILTIN_KINDS.has(kind)) {
    return res.status(400).json({ error: `not an editable built-in skill: ${kind}` });
  }
  const file = join(resolve(STATE_DIR, 'skills', kind), 'SKILL.md');
  const cat = skillCatalog().find(s => s.kind === kind);
  try {
    const raw = await readFile(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    res.json({
      kind,
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
    });
  } catch {
    // No file yet — hand back the live built-in defaults so the form prefills.
    res.json({
      kind,
      exists: false,
      isNews: kind === 'news',
      label: cat?.label || kind,
      cooldown: msToCooldownStr(cat?.cooldownMs || 0),
      context: (cat?.contextFields || []).join(', '),
      knownContextFields: [...dj.CONTEXT_FIELDS],
      feed: cat?.feed || null,
      feedMaxItems: cat?.feedMaxItems || null,
      brief: cat?.description || '',
    });
  }
});

// ---------------------------------------------------------------------------
// PUT /dj/skills/:kind/file — write a built-in skill's SKILL.md from the admin
// edit form (brief/cooldown/label, + feed/feedMaxItems for news), then reload
// so the override applies immediately. Scoped to the 7 built-in kinds.
// ---------------------------------------------------------------------------
router.put('/dj/skills/:kind/file', requireAdmin, async (req, res) => {
  const kind = req.params.kind;
  if (!BUILTIN_KINDS.has(kind)) {
    return res.status(400).json({ error: `not an editable built-in skill: ${kind}` });
  }
  const b = req.body || {};
  const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
  if (!brief) return res.status(400).json({ error: 'brief is required' });

  const cooldown = typeof b.cooldown === 'string' ? b.cooldown.trim() : '';
  if (cooldown && !/^\d+\s*[smhd]?$/.test(cooldown)) {
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
    await writeBuiltinSkillFile(fields);
    await loadCustomSkills();
    queue.log('scheduler', `[skills] built-in "${kind}" edited via admin UI`);
    res.json({ skills: skillCatalog() });
  } catch (err: any) {
    queue.log('error', `PUT /dj/skills/${kind}/file failed: ${err.message}`);
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
    const queuePosition = await queue.push({ track, requestedBy: 'studio' });
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
