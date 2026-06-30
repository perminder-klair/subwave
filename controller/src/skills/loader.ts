// Skill loader — the single source of truth for the DJ's between-track segment
// capabilities. Every skill, shipped or operator-added, is a self-contained
// directory:
//
//   <dir>/<slug>/
//     SKILL.md     frontmatter (→ metadata) + body (→ the agent's brief)
//     tool.mjs     OPTIONAL: a data fetcher the segment director calls first
//
// Two roots are scanned:
//   1. controller/src/skills/builtins/<kind>/   — the seven shipped built-ins
//      (first-party, read-only; bundled in the image / bind-mounted in dev).
//   2. ${STATE_DIR}/skills/<slug>/              — operator skills + built-in
//      brief overrides (state/skills/<built-in-kind> edits the shipped brief).
//
// A skill's tool.mjs is the same contract for both:
//   export default async (ctx, state, services, config) => data
//   export const description = '…'   // OPTIONAL: tool description for the agent
//   export const ready = (services) => boolean   // OPTIONAL: gate availability
// `services` (station-services.ts) is the curated facade onto search, the
// library, the play log, feeds and durable recall — the one way a tool reaches
// the world, so built-in and custom skills run on identical footing.
//
// Safety posture (operator code in state/skills is the operator's own, same
// trust model as a local Claude Code skill, but still fenced):
//   - malformed skills are skipped with a logged warning, never crash boot
//   - custom skills are DISCOVERED-BUT-DISABLED — they appear in /admin/skills
//     toggled off and cannot air until the operator enables them
//   - a custom tool.mjs runs behind a timeout + try/catch at the call site
//     (llm/segment-tools.ts); built-in tools are first-party and unfenced

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { STATE_DIR } from '../config.js';
import { queue, registerSkillKinds } from '../broadcast/queue.js';
import { buildStationServices } from '../llm/internal/tools/station-services.js';

// Shipped built-in skill directories, resolved relative to this module so it
// works under both dev (tsx on bind-mounted src) and prod (tsx on the COPYd
// src). Exported so the scaffolder can seed editable state overrides from them.
export const BUILTINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'builtins');
const SKILLS_DIR = resolve(STATE_DIR, 'skills');
const SLUG_RE_INNER = /^[a-z0-9][a-z0-9-]{0,48}$/;

// Custom-skill slug: lowercase, starts alphanumeric, then alphanumeric/hyphen,
// ≤49 chars. Anchored, so it can't contain '/', '.', or whitespace — the routes
// rely on that to keep a slug from escaping state/skills/. Exported so the admin
// create route validates against the exact pattern the loader enforces.
export const SLUG_RE = SLUG_RE_INNER;

// Kinds the queue reserves for its own voice channels — a custom skill may not
// shadow these (built-in kinds are added below, once loaded).
const QUEUE_INTERNAL_KINDS = ['link', 'dj-speak', 'announcement', 'station-id', 'hourly', 'hourly-check'];

// Derived at load time from the built-in directories. Exported as live sets that
// callers (.has()) read after boot. `BUILTIN_KINDS` is the set of shipped kinds;
// `RESERVED_KINDS` adds the queue-internal kinds a custom skill can't shadow.
export const BUILTIN_KINDS = new Set<string>();
export const RESERVED_KINDS = new Set<string>(QUEUE_INTERNAL_KINDS);

let builtinBase: any[] = [];          // the shipped built-in caps (from BUILTINS_DIR)
let loadedCustom: any[] = [];         // operator custom caps (from state/skills)
let builtinOverrides: Record<string, any> = {}; // built-in brief overrides (from state/skills)
let importCounter = 0;                // cache-buster for re-importing edited tool.mjs

export function builtinBaseCaps(): any[] { return builtinBase; }
export function customCapabilities(): any[] { return loadedCustom; }
export function getBuiltinOverrides(): Record<string, any> { return builtinOverrides; }

// Built-in caps with operator brief-edits from state/skills/<kind>/SKILL.md
// applied. An override contributes only the keys it specified — desc / cooldown
// / label / context and, for news, feed / feedMaxItems — merged over the shipped
// default; the tool (toolFn / ready / toolName) is always the first-party one.
// Read live so a rescan takes effect without a restart.
export function builtinCapabilities(): any[] {
  return builtinBase.map(c => {
    const ov = builtinOverrides[c.kind];
    if (!ov) return c;
    return { ...c, ...ov, config: { ...c.config, ...ov.config } };
  });
}

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

// Dynamically import a skill's optional tool.mjs. Returns the data function plus
// its optional `description` / `ready` exports, or null when there's no tool.
async function loadToolModule(dir: string): Promise<{ fn: any; description?: string; ready?: any } | null> {
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
    throw new Error('tool.mjs must export a default async function (ctx, state, services, config) => data');
  }
  return {
    fn,
    description: typeof mod.description === 'string' ? mod.description : undefined,
    ready: typeof mod.ready === 'function' ? mod.ready : undefined,
  };
}

// Build a full capability from a skill directory. `builtin` controls the trust
// posture: built-ins are first-party (custom:false, tool unfenced); state skills
// are operator code (custom:true, fenced at the call site).
async function loadSkillDir(dir: string, slug: string, { builtin }: { builtin: boolean }): Promise<any | null> {
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
  if (!builtin && !body) {
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
    custom: !builtin,
    window: data.window === 'commute' ? 'commute' : 'any',
    requiresKey,
    // Absent → effectiveContextFields() falls back to the default profile (#471).
    contextFields: parseContextFields(data.context ?? data.contextFields),
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
  }

  return cap;
}

// Scan the shipped built-in directories. Populates builtinBase + the derived
// BUILTIN_KINDS / RESERVED_KINDS sets. Runs once at boot (built-ins are static).
export async function loadBuiltins(): Promise<any[]> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(BUILTINS_DIR, { withFileTypes: true });
    entries = dirents.filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch (err: any) {
    queue.log('error', `[skills] could not read built-ins dir ${BUILTINS_DIR}: ${err?.message || err}`);
    builtinBase = [];
    return builtinBase;
  }
  const out: any[] = [];
  for (const slug of entries) {
    try {
      const cap = await loadSkillDir(join(BUILTINS_DIR, slug), slug, { builtin: true });
      if (cap) out.push(cap);
    } catch (err: any) {
      queue.log('error', `[skills] built-in "${slug}" failed to load: ${err.message}`);
    }
  }
  builtinBase = out;
  // Rebuild the derived kind sets.
  BUILTIN_KINDS.clear();
  for (const c of out) BUILTIN_KINDS.add(c.kind);
  RESERVED_KINDS.clear();
  for (const k of QUEUE_INTERNAL_KINDS) RESERVED_KINDS.add(k);
  for (const k of BUILTIN_KINDS) RESERVED_KINDS.add(k);
  return builtinBase;
}

// Scan state/skills and rebuild the custom caps + built-in overrides. Never
// throws — a broken folder is logged and skipped. Ensures built-ins are loaded
// first (so kinds classify correctly). Returns the loaded custom caps.
export async function loadCustomSkills(): Promise<any[]> {
  if (!builtinBase.length) await loadBuiltins();
  builtinOverrides = {};
  let entries: string[] = [];
  try {
    const dirents = await readdir(SKILLS_DIR, { withFileTypes: true });
    entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    loadedCustom = []; // no state/skills dir → nothing custom (the common case)
    return loadedCustom;
  }

  const out: any[] = [];
  const seen = new Set<string>();
  for (const slug of entries) {
    try {
      // A folder named after a built-in kind is an OVERRIDE of that built-in's
      // brief — it never loads a tool.mjs (built-ins keep their first-party
      // tool) and contributes only the frontmatter/body keys it specifies.
      if (BUILTIN_KINDS.has(slug)) {
        const raw = await readFile(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8').catch(() => null);
        if (raw == null) continue;
        const { data, body } = parseFrontmatter(raw);
        const ov: any = { config: data };
        if (body) ov.desc = body;
        if (data.cooldown) ov.cooldownMs = parseCooldownMs(data.cooldown);
        if (data.label) ov.label = data.label.trim();
        const ovContext = parseContextFields(data.context ?? data.contextFields);
        if (ovContext) ov.contextFields = ovContext;
        if (data.feed) ov.feed = data.feed.trim();
        if (data.feedMaxItems) {
          const n = parseInt(data.feedMaxItems, 10);
          if (Number.isFinite(n) && n > 0) ov.feedMaxItems = n;
        }
        if (builtinOverrides[slug]) {
          queue.log('error', `[skills] duplicate built-in override "${slug}" — keeping the first`);
          continue;
        }
        builtinOverrides[slug] = ov;
        continue;
      }
      if (RESERVED_KINDS.has(slug)) {
        queue.log('error', `[skills] "${slug}" rejected — shadows a reserved capability`);
        continue;
      }
      const cap = await loadSkillDir(join(SKILLS_DIR, slug), slug, { builtin: false });
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

  loadedCustom = out;
  // Register every skill kind (built-in + custom) as a recap voice/dedupe kind,
  // so the DJ's anti-repeat memory covers them without a hand-maintained list.
  registerSkillKinds([...BUILTIN_KINDS, ...out.map(c => c.kind)]);
  if (out.length) {
    queue.log('scheduler', `[skills] loaded ${out.length} custom skill(s): ${out.map(c => c.kind).join(', ')}`);
  }
  const ovKinds = Object.keys(builtinOverrides);
  if (ovKinds.length) {
    queue.log('scheduler', `[skills] applied ${ovKinds.length} built-in override(s): ${ovKinds.join(', ')}`);
  }
  return loadedCustom;
}

// Load both roots — built-ins then state. Called once at boot.
export async function loadAllSkills(): Promise<void> {
  await loadBuiltins();
  await loadCustomSkills();
}
