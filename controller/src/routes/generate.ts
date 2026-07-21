// Admin-gated "describe it → draft it" endpoints. Each takes a free-text
// description and returns a draft entity (persona / show / theme) for the create
// forms to pre-fill. Nothing is persisted here — the operator reviews, edits,
// and saves through the normal /settings (or /themes) path. Generation rides the
// operator's configured station LLM via the llm/dj generate* wrappers.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as dj from '../llm/dj.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import { listThemes } from '../themes.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

const DESC_MAX = 400;

function readDescription(req: express.Request): string {
  return (typeof req.body?.description === 'string' ? req.body.description : '')
    .trim()
    .slice(0, DESC_MAX);
}

// POST /generate/persona — { description } → { ok, persona }
router.post('/generate/persona', requireAdmin, async (req, res) => {
  const description = readDescription(req);
  if (!description) return res.status(400).json({ error: 'description is required' });
  try {
    const out = await dj.generatePersona(description);
    res.json({ ok: true, persona: out });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /generate/show — { description } → { ok, show }
// The route assembles the persona/theme/mood/genre context itself so the client
// only sends a description.
router.post('/generate/show', requireAdmin, async (req, res) => {
  const description = readDescription(req);
  if (!description) return res.status(400).json({ error: 'description is required' });
  try {
    const s = settings.get();
    const personas = (s.personas || []).map((p: any) => ({ id: p.id, name: p.name }));
    const themes = (await listThemes()).map(t => ({ id: t.id, name: t.name }));
    let genres: string[] = [];
    try {
      await library.load();
      genres = Object.keys(library.stats().byGenre || {});
    } catch {}

    const out = await dj.generateShow(description, { personas, themes, genres });
    const raw: any = { ...out };

    // Soft-normalise against the real lists — a near-miss from a weaker model
    // becomes null/default rather than an invalid id the Save would reject.
    const personaIds = new Set(personas.map(p => p.id));
    if (!raw.personaId || !personaIds.has(raw.personaId)) {
      raw.personaId = personas[0]?.id ?? null;
    }
    const themeIds = new Set(themes.map(t => t.id));
    if (!raw.themeId || !themeIds.has(raw.themeId)) raw.themeId = null;
    // The LLM schema stays singular (kinder to weak local models); the client
    // form is multi-value (#929), so lift each field into a one-element list.
    // An unknown/missing mood becomes [] (Any — the autonomous mood applies)
    // rather than an arbitrary vocabulary entry the operator didn't ask for.
    const moods = raw.mood && settings.SHOW_MOODS.includes(raw.mood) ? [raw.mood] : [];
    const genreDraft = typeof raw.genre === 'string' ? raw.genre.trim() : '';
    const showGenres = genreDraft ? [genreDraft] : [];
    const energies = raw.energy && settings.SHOW_ENERGY.includes(raw.energy) ? [raw.energy] : [];
    const eras = raw.fromYear != null || raw.toYear != null
      ? [{ fromYear: raw.fromYear ?? null, toYear: raw.toYear ?? null }]
      : [];
    // Strict only makes sense with at least one music filter to lock to.
    const filtersStrict = raw.filtersStrict === true
      && !!(showGenres.length || moods.length || energies.length || eras.length);

    const draft = {
      name: raw.name,
      topic: raw.topic,
      personaId: raw.personaId,
      themeId: raw.themeId,
      moods,
      genres: showGenres,
      energies,
      eras,
      filtersStrict,
    };

    res.json({ ok: true, show: draft });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Manual-voice suggestion chips (admin dash "Manual voice DJ" card). The last
// generated batch is cached in memory only — after a controller restart the
// dash falls back to its hardcoded set until the operator hits refresh again.
let sayCache: { suggestions: string[]; generatedAt: string } | null = null;

// A weak model's batch arrives here raw (the Zod schema is deliberately
// unbounded): strip list markers and wrapping quotes, drop empties, dupes,
// and over-long lines. Under 3 survivors the caller treats it as a failure.
function normalizeSuggestions(raw: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== 'string') continue;
    const s = item
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .trim();
    if (!s || s.length > 120) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 8);
}

// GET /generate/say-suggestions — the cached batch, never a model call.
// suggestions: null = nothing generated since boot (client keeps its fallback).
router.get('/generate/say-suggestions', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    suggestions: sayCache?.suggestions ?? null,
    generatedAt: sayCache?.generatedAt ?? null,
  });
});

// POST /generate/say-suggestions — generate a fresh batch and cache it.
// Explicit operator action (the ↻ button), so — like the manual /dj/segment
// runners — intentionally not budget-gated.
router.post('/generate/say-suggestions', requireAdmin, async (_req, res) => {
  try {
    const ctx = await getFullContext();
    const nowPlaying = await queue.getNowPlaying().catch(() => null);
    // Small local models routinely under-deliver the asked-for 6 (two lines is
    // common from a 4B). One extra attempt, MERGING batches rather than
    // discarding the first — two half-batches at temperature 0.9 usually add
    // up. Bounded at 2 calls total: this is an explicit operator click, and
    // the configured station model may be slow (see CLAUDE.md on retries).
    let suggestions: string[] = [];
    for (let attempt = 0; attempt < 2 && suggestions.length < 3; attempt++) {
      const batch = await dj.generateSaySuggestions(ctx, nowPlaying);
      suggestions = normalizeSuggestions([...suggestions, ...batch]);
    }
    if (suggestions.length < 3) {
      throw new Error('model returned too few usable suggestions');
    }
    sayCache = { suggestions, generatedAt: new Date().toISOString() };
    res.json({ ok: true, ...sayCache });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /generate/theme — { description, mode } → { ok, theme }
// Returns tokens for review; persisting is POST /themes.
router.post('/generate/theme', requireAdmin, async (req, res) => {
  const description = readDescription(req);
  if (!description) return res.status(400).json({ error: 'description is required' });
  const mode = req.body?.mode === 'light' ? 'light' : 'dark';
  try {
    const out = await dj.generateTheme(description, mode);
    res.json({ ok: true, theme: { ...out, mode } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
