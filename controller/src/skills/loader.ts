// Skill loader — the single source of truth for the DJ's between-track segment
// capabilities. Every skill, shipped or operator-added, is a self-contained
// directory under ONE runtime load root, ${STATE_DIR}/skills/<slug>/:
//
//   <slug>/
//     SKILL.md     frontmatter (→ metadata) + body (→ the agent's brief)
//     tool.mjs     OPTIONAL: a data fetcher the segment director calls first
//
// The seven built-ins are not special at load time: they are *seeded* into
// state/skills on first boot from read-only templates that ship in the image
// (src/skills/builtins/<kind>/, see scaffold.js → seedBuiltinSkills), then loaded
// exactly like an operator skill. The only residue of "built-in" is the
// SEEDED_KINDS set (the shipped kinds), which drives a few first-party
// affordances — enabled-by-default, can't-hard-delete, reset-to-default, and
// reserved naming — NOT a separate load path or trust posture.
//
// A skill's tool.mjs is the same contract for everyone:
//   export default async (ctx, state, services, config, input) => data
//   export const description = '…'   // OPTIONAL: tool description for the agent
//   export const ready = (services) => boolean   // OPTIONAL: gate availability
//   export const inputs = { query: '…' }   // OPTIONAL: agent-steerable string
//     params ({ name: description }); validated values arrive as `input`
// `services` (station-services.ts) is the curated facade onto search, the
// library, the play log, feeds and durable recall — the one way a tool reaches
// the world. Every tool runs behind a timeout + try/catch at the call site
// (llm/segment-tools.js), seeded or operator-authored alike.
//
// Safety posture (operator code in state/skills is the operator's own, same
// trust model as a local Claude Code skill, but still fenced):
//   - malformed skills are skipped with a logged warning, never crash boot
//   - operator (non-seeded) skills are DISCOVERED-BUT-DISABLED — they appear in
//     /admin/skills toggled off and cannot air until the operator enables them
//   - every tool.mjs runs behind a timeout + try/catch (llm/segment-tools.js)

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { STATE_DIR } from '../config.js';
import { queue, registerSkillKinds } from '../broadcast/queue.js';
import { buildStationServices } from '../llm/internal/tools/station-services.js';

// Shipped built-in TEMPLATE store, resolved relative to this module so it works
// under both dev (tsx on bind-mounted src) and prod (tsx on the COPYd src). This
// is NOT a runtime load root — it is read only by the seeder + reset route
// (scaffold.js). Exported so those can resolve template files.
export const BUILTINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'builtins');
// The COMMUNITY skill catalog is no longer shipped in the image — it's fetched
// live from the `subwave-community` repo. listCommunitySkills / readCommunitySkill
// (re-exported below) delegate to community/registry.ts; every route + admin-UI
// consumer is unchanged.
const SKILLS_DIR = resolve(STATE_DIR, 'skills');
const SLUG_RE_INNER = /^[a-z0-9][a-z0-9-]{0,48}$/;

// Custom-skill slug: lowercase, starts alphanumeric, then alphanumeric/hyphen,
// ≤49 chars. Anchored, so it can't contain '/', '.', or whitespace — the routes
// rely on that to keep a slug from escaping state/skills/. Exported so the admin
// create route validates against the exact pattern the loader enforces.
export const SLUG_RE = SLUG_RE_INNER;

// Kinds the queue reserves for its own voice channels — a custom skill may not
// shadow these (seeded kinds are added below, once discovered).
const QUEUE_INTERNAL_KINDS = ['link', 'dj-speak', 'announcement', 'station-id', 'hourly', 'hourly-check'];

// Derived at boot from the template directories. Exported as live sets that
// callers (.has()) read after boot. `SEEDED_KINDS` is the set of shipped kinds;
// `RESERVED_KINDS` adds the queue-internal kinds a custom skill can't shadow.
export const SEEDED_KINDS = new Set<string>();
export const RESERVED_KINDS = new Set<string>(QUEUE_INTERNAL_KINDS);

let loadedSkills: any[] = []; // the single live capability set (seeded + custom)
let importCounter = 0;        // cache-buster for re-importing edited tool.mjs

// The full live capability set — seeded built-ins and operator skills, loaded on
// identical footing. Read live so a rescan takes effect without a restart.
export function loadedCapabilities(): any[] { return loadedSkills; }

// Minimal flat-YAML frontmatter parser. The frontmatter we accept is a small,
// flat key: value block — no nesting, lists, or multiline scalars — so a tiny
// parser keeps the dependency surface at zero (no gray-matter). Returns
// { data, body }; body is everything after the closing `---`.
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '');
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) data[key] = val;
  }
  return { data, body: m[2].trim() };
}

// "90m" | "6h" | "2d" | "45s" | "45" (bare = minutes) → ms. Defaults to 60 min.
function parseCooldownMs(raw: string | undefined): number {
  const def = 60 * 60 * 1000;
  if (!raw) return def;
  const m = /^(\d+)\s*([smhd]?)$/.exec(String(raw).trim());
  if (!m) return def;
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const mult = unit === 's' ? 1000 : unit === 'h' ? 3600_000 : unit === 'd' ? 86_400_000 : 60_000;
  return n * mult;
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Parse a `context:` (or `contextFields:`) comma list into lowercase tokens, or
// undefined when absent/empty (→ the default profile downstream, see #471).
function parseContextFields(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const list = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : undefined;
}

// Freeform organisation tags (`tags: late-night, factual`) — operator vocabulary
// for filtering the admin skill list. Lowercase slugs, deduped, capped; invalid
// entries are dropped (lenient, like every other frontmatter field). Exported so
// the admin routes normalise form input with the exact rules the loader applies.
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const TAGS_PER_SKILL_LIMIT = 8;
export function parseTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out: string[] = [];
  for (const item of list) {
    const tag = String(item ?? '').trim().toLowerCase();
    if (!TAG_RE.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= TAGS_PER_SKILL_LIMIT) break;
  }
  return out;
}

// A shipped built-in template, read on demand by the seeder / reset route /
// admin "defaults" payload. The template FILES are never kept resident.
export interface SkillTemplate {
  kind: string;
  skillMd: string;            // raw SKILL.md text (for verbatim seeding)
  data: Record<string, string>;
  body: string;
  toolPath: string | null;    // absolute path to tool.mjs, or null (prompt-only)
}

// Read a shipped template's files. Returns null when there's no such template.
export async function readTemplate(kind: string): Promise<SkillTemplate | null> {
  const dir = join(BUILTINS_DIR, kind);
  let skillMd: string;
  try {
    skillMd = await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(skillMd);
  let toolPath: string | null = join(dir, 'tool.mjs');
  try { await stat(toolPath); } catch { toolPath = null; }
  return { kind, skillMd, data, body, toolPath };
}

// The community skill catalog now lives in the `subwave-community` repo and is
// fetched live (community/registry.ts). `CommunitySkill` + the list/read
// accessors are re-exported here unchanged so routes/dj.ts + routes/public.ts +
// the admin UI keep importing them from this module.
export type { CommunitySkill } from '../community/registry.js';
export { communitySkills as listCommunitySkills, readCommunitySkill } from '../community/registry.js';

// Discover the shipped kinds from the template dir names and (re)build the
// derived SEEDED_KINDS / RESERVED_KINDS sets. Cheap — readdir only; the template
// FILES are read on demand. Runs once at boot (templates are static).
export async function discoverSeededKinds(): Promise<Set<string>> {
  SEEDED_KINDS.clear();
  try {
    const dirents = await readdir(BUILTINS_DIR, { withFileTypes: true });
    for (const d of dirents) if (d.isDirectory()) SEEDED_KINDS.add(d.name);
  } catch (err: any) {
    queue.log('error', `[skills] could not read built-in templates ${BUILTINS_DIR}: ${err?.message || err}`);
  }
  RESERVED_KINDS.clear();
  for (const k of QUEUE_INTERNAL_KINDS) RESERVED_KINDS.add(k);
  for (const k of SEEDED_KINDS) RESERVED_KINDS.add(k);
  return SEEDED_KINDS;
}

// A tool.mjs `inputs` export declares agent-steerable string parameters:
// a flat { paramName: 'description for the agent' } object. Sanitised here —
// only identifier-shaped keys with string descriptions survive, so a malformed
// export narrows to nothing instead of breaking the tool-call JSON schema.
const INPUT_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,48}$/;
function sanitizeToolInputs(raw: any): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (INPUT_KEY_RE.test(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// Dynamically import a skill's optional tool.mjs. Returns the data function plus
// its optional `description` / `ready` / `inputs` exports, or null when there's
// no tool.
async function loadToolModule(dir: string): Promise<{ fn: any; description?: string; ready?: any; inputs?: Record<string, string> } | null> {
  const file = join(dir, 'tool.mjs');
  try {
    await stat(file);
  } catch {
    return null; // no tool.mjs — pure-generation skill, that's fine
  }
  // Cache-bust so a rescan picks up an edited module (ESM caches by URL).
  const url = `${pathToFileURL(file).href}?v=${++importCounter}`;
  const mod = await import(url);
  const fn = mod.default || mod.fetchData || mod.tool;
  if (typeof fn !== 'function') {
    throw new Error('tool.mjs must export a default async function (ctx, state, services, config, input) => data');
  }
  return {
    fn,
    description: typeof mod.description === 'string' ? mod.description : undefined,
    ready: typeof mod.ready === 'function' ? mod.ready : undefined,
    inputs: sanitizeToolInputs(mod.inputs),
  };
}

// Build a full capability from a skill directory. `seeded` controls the
// first-party affordances (enabled-by-default, can't-delete, reset) — NOT the
// trust posture: every loaded tool runs fenced at the call site, seeded or not.
async function loadSkillDir(dir: string, slug: string, { seeded }: { seeded: boolean }): Promise<any | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null; // directory without a SKILL.md — not a skill
  }
  const { data, body } = parseFrontmatter(raw);
  const name = (data.name || slug).trim();
  if (!SLUG_RE.test(name)) {
    queue.log('error', `[skills] "${slug}" rejected — name "${name}" must be a lowercase slug`);
    return null;
  }
  // A seeded built-in always ships a brief; an operator skill must supply one.
  if (!seeded && !body) {
    queue.log('error', `[skills] "${slug}" rejected — SKILL.md body (the agent's brief) is empty`);
    return null;
  }

  const requiresKey = data.requiresKey ? String(data.requiresKey).trim() : null;

  let toolMod: any = null;
  try {
    toolMod = await loadToolModule(dir);
  } catch (err: any) {
    queue.log('error', `[skills] "${slug}" tool.mjs failed to load — running prompt-only: ${err.message}`);
    toolMod = null;
  }

  const label = (data.label || titleCase(name)).trim();
  const cap: any = {
    kind: name,
    skill: name,
    label,
    cooldownMs: parseCooldownMs(data.cooldown),
    desc: body,
    // Provenance, NOT trust: a shipped kind (seeded into state) vs an operator
    // skill. Drives enabled-by-default + the admin delete/reset affordances.
    seeded,
    window: data.window === 'commute' ? 'commute' : 'any',
    requiresKey,
    // Absent → effectiveContextFields() falls back to the default profile (#471).
    contextFields: parseContextFields(data.context ?? data.contextFields),
    // Freeform organisation tags for the admin skill list.
    tags: parseTags(data.tags),
    // The skill's own frontmatter, handed to the tool as its 4th arg so a skill
    // can read its own knobs (e.g. news' feed / feedMaxItems).
    config: data,
    feed: data.feed ? data.feed.trim() : undefined,
    feedMaxItems: data.feedMaxItems && Number.isFinite(parseInt(data.feedMaxItems, 10)) ? parseInt(data.feedMaxItems, 10) : undefined,
  };

  // Readiness: a tool module's `ready(services)` wins; else a keyed skill is
  // ready only when its env var is set; else always ready.
  if (toolMod?.ready) {
    cap.ready = () => toolMod.ready(buildStationServices());
  } else if (requiresKey) {
    cap.ready = () => !!process.env[requiresKey];
  }

  if (toolMod?.fn) {
    cap.toolFn = toolMod.fn;
    cap.toolName = `skill_${name.replace(/-/g, '_')}`;
    cap.toolDesc = (toolMod.description || data.toolDescription || '').trim()
      || `Fetch live data for the ${label} segment before speaking. Returns { available: false } when there is nothing fresh worth airing.`;
    // Optional agent-steerable parameters ({ name: description }, strings
    // only) — becomes the tool's input schema in llm/segment-tools.js and is
    // handed to toolFn as its 5th argument. Absent → zero-arg tool, the
    // historical shape.
    cap.toolInputs = toolMod.inputs;
  }

  return cap;
}

// Scan the single load root (state/skills) and rebuild the live capability set.
// Never throws — a broken folder is logged and skipped. Ensures the seeded kinds
// are discovered first (so folders classify correctly). Returns the loaded caps.
export async function loadSkills(): Promise<any[]> {
  if (!SEEDED_KINDS.size) await discoverSeededKinds();
  let entries: string[] = [];
  try {
    const dirents = await readdir(SKILLS_DIR, { withFileTypes: true });
    entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    loadedSkills = []; // no state/skills dir yet → nothing to load
    registerSkillKinds([]);
    return loadedSkills;
  }

  const out: any[] = [];
  const seen = new Set<string>();
  for (const slug of entries) {
    try {
      // A folder shadowing a queue-internal kind (link/dj-speak/…) is rejected.
      // Seeded kinds live in RESERVED_KINDS too but are legitimate, so exempt them.
      if (RESERVED_KINDS.has(slug) && !SEEDED_KINDS.has(slug)) {
        queue.log('error', `[skills] "${slug}" rejected — shadows a reserved capability`);
        continue;
      }
      const cap = await loadSkillDir(join(SKILLS_DIR, slug), slug, { seeded: SEEDED_KINDS.has(slug) });
      if (!cap) continue;
      if (seen.has(cap.kind)) {
        queue.log('error', `[skills] duplicate skill kind "${cap.kind}" — keeping the first`);
        continue;
      }
      seen.add(cap.kind);
      out.push(cap);
    } catch (err: any) {
      queue.log('error', `[skills] "${slug}" failed to load: ${err.message}`);
    }
  }

  loadedSkills = out;
  // Register every loaded kind as a recap voice/dedupe kind, so the DJ's
  // anti-repeat memory covers them without a hand-maintained list.
  registerSkillKinds(out.map(c => c.kind));
  const seededN = out.filter(c => c.seeded).length;
  const customN = out.length - seededN;
  queue.log('scheduler', `[skills] loaded ${out.length} skill(s): ${seededN} built-in, ${customN} custom`);
  return loadedSkills;
}
