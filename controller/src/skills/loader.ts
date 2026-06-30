// Operator-pluggable skills — load custom between-track segment capabilities
// from `${STATE_DIR}/skills/<slug>/SKILL.md` at boot (and on demand via the
// admin "rescan" button), and merge them into the segment director's
// CAPABILITIES table (see skills/_agent.js).
//
// This adopts the *format* of Anthropic's skills (a SKILL.md with YAML
// frontmatter + a markdown body, plus optional code) — NOT their semantics.
// A SUB/WAVE skill is one thing: a between-track spoken segment. The
// frontmatter supplies the capability metadata; the markdown body IS the
// agent's brief for that segment; an optional `tool.mjs` is wrapped as an AI
// SDK tool so the segment can look at live data before the DJ speaks.
//
//   state/skills/on-this-day-music/
//     SKILL.md     frontmatter (→ metadata) + body (→ the agent's brief)
//     tool.mjs     OPTIONAL: `export default async (ctx) => ({...})`
//
// SKILL.md frontmatter keys (all optional except a non-empty body):
//   name             slug == kind (defaults to the folder name)
//   label            human label for /admin/skills (defaults to a title-cased name)
//   cooldown         hard min gap between autonomous firings — "90m" | "6h" | "45" (minutes)
//   window           "any" (default) | "commute" — only offered during commute hours
//   requiresKey      env var the skill needs; absent → never offered
//   toolDescription  description shown to the agent for the tool.mjs data tool
//   context          comma-separated "right now" fields the segment may weave in
//                    — any of: date, clock, time, weather, festival, show,
//                    listeners. Absent → the default profile (everything EXCEPT
//                    weather), so a skill only mentions weather when it opts in
//                    (issue #471). e.g. `context: time, weather` for a commute-
//                    conditions skill where weather is genuinely topical.
//
// EDITING BUILT-INS: a folder named after a built-in kind (weather, news, …;
// see BUILTIN_KINDS) is treated as an OVERRIDE — it edits the shipped built-in's
// brief/cooldown/label/context in place (and, for `news`, its `feed:` RSS URL +
// `feedMaxItems`) rather than being rejected as a clash. Built-in overrides may
// leave the body empty (= keep the default brief) and never load a tool.mjs.
// These files are scaffolded on first boot (see skills/scaffold.js).
//
// Safety posture (the operator is dropping code into their own controller, same
// trust model as Claude Code skills, but we still fence it):
//   - malformed skills are skipped with a logged warning, never crash boot
//   - custom skills are DISCOVERED-BUT-DISABLED — they appear in /admin/skills
//     toggled off and cannot air until the operator enables them (see
//     skillCatalog/availableCapabilities in _agent.js); merely dropping a
//     folder never auto-airs unreviewed content or runs its code on a tick
//   - tool.mjs execution is wrapped in a timeout + try/catch at the call site
//     (llm/segment-tools.js) so a slow or throwing skill can't hang the tick

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATE_DIR } from '../config.js';
import { queue } from '../broadcast/queue.js';

// The 7 built-in segment capabilities (see skills/_agent.js CAPABILITIES). A
// state/skills/<kind>/SKILL.md whose folder name matches one of these is parsed
// as an OVERRIDE of that built-in (brief/cooldown/label, + feed for news) rather
// than rejected — that's how operators edit the shipped skills. Everything else
// in RESERVED_KINDS is queue-internal and stays un-overridable.
export const BUILTIN_KINDS = new Set([
  'weather', 'news', 'now-playing-dig', 'curiosity',
  'album-anniversary', 'library-deep-cut', 'web-search',
]);

// Built-in capability kinds — custom skills may not shadow these. Exported so
// the admin create route (POST /dj/skills) rejects the same set the loader does.
export const RESERVED_KINDS = new Set([
  ...BUILTIN_KINDS,
  // queue.announce reserves 'link' for the light-ducked intro channel.
  'link', 'dj-speak', 'announcement', 'station-id', 'hourly',
]);

const SKILLS_DIR = resolve(STATE_DIR, 'skills');
// Custom-skill slug: lowercase, starts alphanumeric, then alphanumeric/hyphen,
// ≤49 chars. Anchored, so it can't contain '/', '.', or whitespace — the routes
// rely on that to keep a slug from escaping state/skills/. Exported so the admin
// create route validates against the exact pattern the loader enforces.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

// Loaded custom capabilities, in the same shape as _agent.js CAPABILITIES,
// plus { custom: true } and an optional wrapped data tool. Rebuilt on reload.
let loaded: any[] = [];
// Overrides for built-in capabilities, keyed by kind. A built-in SKILL.md only
// contributes the keys it actually specifies (desc/cooldownMs/label/feed/…),
// merged over the hardcoded CAPABILITIES entry in _agent.js. Rebuilt on reload.
let builtinOverrides: Record<string, any> = {};
let importCounter = 0; // cache-buster for re-importing edited tool.mjs modules

export function customCapabilities(): any[] {
  return loaded;
}

export function getBuiltinOverrides(): Record<string, any> {
  return builtinOverrides;
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
    // Strip surrounding quotes if present.
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

// Parse a `context:` (or `contextFields:`) frontmatter value — a comma list of
// "right now" field names — into lowercase tokens, or undefined when absent or
// empty. Unknown tokens are kept here and dropped downstream (buildContextLines
// validates against CONTEXT_FIELDS), so the loader stays dependency-free.
function parseContextFields(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const list = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : undefined;
}

// Dynamically import a skill's optional tool.mjs and return its data function,
// or null. The function is invoked per tick with the moment's context; the
// call itself is timeout-guarded at the call site (segment-tools.js).
async function loadToolFn(dir: string): Promise<((ctx: any, state: any) => any) | null> {
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
    throw new Error('tool.mjs must export a default async function (ctx) => data');
  }
  return fn;
}

async function loadOne(slug: string): Promise<any | null> {
  const dir = join(SKILLS_DIR, slug);
  const skillFile = join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = await readFile(skillFile, 'utf8');
  } catch {
    return null; // directory without a SKILL.md — not a skill
  }

  const { data, body } = parseFrontmatter(raw);
  const name = (data.name || slug).trim();

  if (!SLUG_RE.test(name)) {
    queue.log('error', `[skills] "${slug}" rejected — name "${name}" must be a lowercase slug`);
    return null;
  }
  // A file named after a built-in kind is an OVERRIDE, not a new skill: it
  // contributes only the keys it specifies, merged over the hardcoded
  // CAPABILITIES entry (see builtinCapabilities() in _agent.js). Unlike custom
  // skills, the body may be empty — that just means "keep the default brief but
  // override e.g. the feed". No tool.mjs is loaded for built-ins (they already
  // have their own data tool wired by kind in llm/segment-tools.js).
  if (BUILTIN_KINDS.has(name)) {
    const override: any = { override: true, kind: name };
    if (body) override.desc = body;
    if (data.cooldown) override.cooldownMs = parseCooldownMs(data.cooldown);
    if (data.label) override.label = data.label.trim();
    const ovContext = parseContextFields(data.context ?? data.contextFields);
    if (ovContext) override.contextFields = ovContext;
    if (data.feed) override.feed = data.feed.trim();
    if (data.feedMaxItems) {
      const n = parseInt(data.feedMaxItems, 10);
      if (Number.isFinite(n) && n > 0) override.feedMaxItems = n;
    }
    return override;
  }
  if (RESERVED_KINDS.has(name)) {
    queue.log('error', `[skills] "${slug}" rejected — "${name}" shadows a built-in capability`);
    return null;
  }
  if (!body) {
    queue.log('error', `[skills] "${slug}" rejected — SKILL.md body (the agent's brief) is empty`);
    return null;
  }

  const window = data.window === 'commute' ? 'commute' : 'any';
  const requiresKey = data.requiresKey ? String(data.requiresKey).trim() : null;

  let toolFn: any = null;
  try {
    toolFn = await loadToolFn(dir);
  } catch (err: any) {
    queue.log('error', `[skills] "${slug}" tool.mjs failed to load — running prompt-only: ${err.message}`);
    toolFn = null;
  }

  const cap: any = {
    kind: name,
    skill: name,
    label: (data.label || titleCase(name)).trim(),
    cooldownMs: parseCooldownMs(data.cooldown),
    desc: body,
    custom: true,
    window,
    requiresKey,
    // Absent → effectiveContextFields() falls back to the default profile (no
    // weather). A skill opts weather (or any field) in via `context:` (#471).
    contextFields: parseContextFields(data.context ?? data.contextFields),
    // A keyed skill is only ready when its env var is set. Keyless skills are
    // always ready. Mirrors the built-in `ready()` convention.
    ready: requiresKey ? () => !!process.env[requiresKey] : undefined,
  };

  if (toolFn) {
    cap.toolName = `skill_${name.replace(/-/g, '_')}`;
    cap.toolDesc = (data.toolDescription || '').trim()
      || `Fetch live data for the ${cap.label} segment before speaking. Returns { available: false } when there is nothing fresh worth airing.`;
    cap.toolFn = toolFn;
  }

  return cap;
}

// Scan state/skills and rebuild the loaded capability list. Never throws —
// a broken skill folder is logged and skipped. Returns the loaded caps.
export async function loadCustomSkills(): Promise<any[]> {
  builtinOverrides = {};
  let entries: string[] = [];
  try {
    const dirents = await readdir(SKILLS_DIR, { withFileTypes: true });
    entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    loaded = []; // no state/skills dir → nothing to load (the common case)
    return loaded;
  }

  const out: any[] = [];
  const seen = new Set<string>();
  for (const slug of entries) {
    try {
      const cap = await loadOne(slug);
      if (!cap) continue;
      // Built-in override (file named after a built-in kind) — collected
      // separately and merged onto CAPABILITIES, never added as a custom skill.
      if (cap.override) {
        if (builtinOverrides[cap.kind]) {
          queue.log('error', `[skills] duplicate built-in override "${cap.kind}" — keeping the first`);
          continue;
        }
        builtinOverrides[cap.kind] = cap;
        continue;
      }
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

  loaded = out;
  if (out.length) {
    queue.log('scheduler', `[skills] loaded ${out.length} custom skill(s): ${out.map(c => c.kind).join(', ')}`);
  }
  const ovKinds = Object.keys(builtinOverrides);
  if (ovKinds.length) {
    queue.log('scheduler', `[skills] applied ${ovKinds.length} built-in override(s): ${ovKinds.join(', ')}`);
  }
  return loaded;
}
