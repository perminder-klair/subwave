# Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin is a skill folder (`state/skills/<slug>/`) that adds an optional `plugin.mjs` giving it event hooks, cron schedules, picker influence, and gated queue/announce actions.

**Architecture:** A new pure module (`skills/plugin-pure.ts`) holds validation and the failure/rate state machines; a new runtime module (`skills/plugin-runtime.ts`) owns hook dispatch, the schedule registry, plugin `ctx` construction, and auto-disable — initialized with `{queue, services}` injected by the loader so it has **no top-level import of the queue chain** (this is what lets `session.ts` and `queue.ts` import `emitStationEvent` without creating the queue↔session-style cycles the codebase deliberately avoids). Three one-line emit points (queue, dj-agent, session), two seams in the pool picker, capability metadata in `skillCatalog()`, badges in the existing admin Skills page.

**Tech Stack:** TypeScript ESM (Node), node-cron (already a dep), existing `tsx scripts/*.test.ts` + `node:assert/strict` test pattern, Next.js admin UI.

**Spec:** `docs/superpowers/specs/2026-07-12-plugin-system-design.md` — read it first; it is the contract.

## Global Constraints

- Repo: work in the existing worktree branch `worktree-plugin-system-design`; PR target is **develop**, never main.
- ESM relative imports use the `.js` suffix even from `.ts` files (codebase-wide convention).
- Merge gate: `npm run lint` in `controller/` AND `web/` (eslint + `tsc --noEmit`). Run both before the final commit.
- **Commit policy (operator preference): stage (`git add`) at the end of each task; do NOT commit until the final task.** The per-task "Stage" steps below replace the usual commit steps.
- No "Generated with Claude Code" attribution in the commit message or PR body.
- Timeouts: hooks/schedules 8000ms, picker candidates/veto 4000ms. Auto-disable threshold: 5 consecutive failures. Schedule rate floor: 5 minutes. Announce cooldown: `max(cap.cooldownMs, 5 min)`. Candidates cap: 5 per plugin. Pending queued tracks cap: 2 per plugin.
- Plugin speech/queueing must ride existing gates: `optionalSegmentsAllowed()` (dj-budget) for announce; `queue.push` dedup + blocklist for tracks.

---

### Task 1: Pure helpers — `plugin-pure.ts` + tests

**Files:**
- Create: `controller/src/skills/plugin-pure.ts`
- Create: `controller/scripts/plugins.test.ts`
- Modify: `controller/package.json` (scripts block, after `"test:connect"`)

**Interfaces:**
- Produces (consumed by Tasks 2, 3, 6):
  - `HOOK_NAMES: readonly ['trackStarted','requestReceived','sessionRolled']` and `type HookName`
  - `interface PluginDefinition { hooks: Partial<Record<HookName, Function>>; schedules: { cron: string; label: string | null; run: Function }[]; picker: { candidates: Function | null; veto: Function | null } }`
  - `validatePluginDefinition(raw: unknown, opts: { isValidCron: (expr: string) => boolean }): { def: PluginDefinition | null; errors: string[]; warnings: string[] }` — `def` is null iff `errors` non-empty or zero capabilities declared
  - `class FailureTracker { constructor(threshold?: number); fail(key: string): boolean; succeed(key: string): void; disabled(key: string): boolean; disabledKeys(prefix?: string): string[]; reset(): void }` — `fail` returns true when the key just crossed the threshold
  - `class RateGate { ok(key: string, minMs: number, now?: number): boolean }` — returns true AND records `now` when the gap since the last recorded pass ≥ `minMs`; first call always passes
  - `capEnabled(cap: { skill: string; seeded?: boolean }, enabledMap: Record<string, boolean>): boolean` — seeded default-on, custom default-off (mirrors `skillCatalog()`'s expression at `skills/_agent.ts:753`)

- [ ] **Step 1: Write the failing test**

Create `controller/scripts/plugins.test.ts`:

```ts
// Unit tests for the plugin system's pure helpers (skills/plugin-pure.ts):
// definition-shape validation, the failure/auto-disable tracker, the rate
// gate, and the shared enabled-map rule.
// Run: `tsx scripts/plugins.test.ts` (or `npm run test:plugins`).
//
// node:assert-via-tsx style, matching scripts/programme.test.ts.

import assert from 'node:assert/strict';
import {
  validatePluginDefinition, FailureTracker, RateGate, capEnabled, HOOK_NAMES,
} from '../src/skills/plugin-pure.js';

const cronOk = { isValidCron: () => true };

// ── validatePluginDefinition ────────────────────────────────────────────────

// A full, well-formed definition normalizes cleanly.
{
  const raw = {
    hooks: { trackStarted: async () => {}, requestReceived: () => {} },
    schedules: [{ cron: '0 18 * * 5', label: 'friday', run: async () => {} }],
    picker: { candidates: async () => [], veto: async () => [] },
  };
  const { def, errors, warnings } = validatePluginDefinition(raw, cronOk);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
  assert.ok(def);
  assert.deepEqual(Object.keys(def!.hooks).sort(), ['requestReceived', 'trackStarted']);
  assert.equal(def!.schedules.length, 1);
  assert.equal(def!.schedules[0]!.label, 'friday');
  assert.equal(typeof def!.picker.candidates, 'function');
  assert.equal(typeof def!.picker.veto, 'function');
}

// Hooks-only is a valid plugin; absent sections normalize to empty shapes.
{
  const { def, errors } = validatePluginDefinition({ hooks: { trackStarted: () => {} } }, cronOk);
  assert.equal(errors.length, 0);
  assert.ok(def);
  assert.deepEqual(def!.schedules, []);
  assert.equal(def!.picker.candidates, null);
  assert.equal(def!.picker.veto, null);
}

// Unknown hook names warn and are dropped; known-but-non-function errors.
{
  const { def, errors, warnings } = validatePluginDefinition(
    { hooks: { trackStarted: () => {}, tractorStarted: () => {} } }, cronOk);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /tractorStarted/);
  assert.deepEqual(Object.keys(def!.hooks), ['trackStarted']);

  const bad = validatePluginDefinition({ hooks: { trackStarted: 'not a fn' } }, cronOk);
  assert.equal(bad.def, null);
  assert.match(bad.errors[0]!, /trackStarted/);
}

// A schedule with a bad cron expression or missing run() is an error.
{
  const noCron = validatePluginDefinition(
    { schedules: [{ cron: 'nope', run: () => {} }] }, { isValidCron: () => false });
  assert.equal(noCron.def, null);
  assert.match(noCron.errors[0]!, /cron/);

  const noRun = validatePluginDefinition({ schedules: [{ cron: '* * * * *' }] }, cronOk);
  assert.equal(noRun.def, null);
  assert.match(noRun.errors[0]!, /run/);
}

// Not an object, or an object declaring nothing, yields def:null.
{
  assert.equal(validatePluginDefinition(null, cronOk).def, null);
  assert.equal(validatePluginDefinition('x', cronOk).def, null);
  const empty = validatePluginDefinition({}, cronOk);
  assert.equal(empty.def, null);
  assert.match(empty.errors[0]!, /no capabilities/i);
}

// Non-function picker members are errors, not silently dropped.
{
  const bad = validatePluginDefinition({ picker: { candidates: 42 } }, cronOk);
  assert.equal(bad.def, null);
  assert.match(bad.errors[0]!, /candidates/);
}

// HOOK_NAMES is the closed set the runtime dispatches on.
assert.deepEqual([...HOOK_NAMES], ['trackStarted', 'requestReceived', 'sessionRolled']);

// ── FailureTracker ──────────────────────────────────────────────────────────

{
  const t = new FailureTracker(3);
  assert.equal(t.fail('a:hook:x'), false);
  assert.equal(t.fail('a:hook:x'), false);
  assert.equal(t.fail('a:hook:x'), true);          // crossed threshold NOW
  assert.equal(t.disabled('a:hook:x'), true);
  assert.equal(t.fail('a:hook:x'), false);          // already disabled — not "just crossed"
  assert.equal(t.disabled('b:hook:x'), false);      // per-key isolation
  assert.deepEqual(t.disabledKeys(), ['a:hook:x']);
  assert.deepEqual(t.disabledKeys('b:'), []);
  t.succeed('b:hook:x');                            // success on another key: no effect on a
  assert.equal(t.disabled('a:hook:x'), true);
  t.reset();
  assert.equal(t.disabled('a:hook:x'), false);
}

// A success resets the consecutive-failure count before the threshold.
{
  const t = new FailureTracker(2);
  t.fail('k');
  t.succeed('k');
  assert.equal(t.fail('k'), false);                 // count restarted at 1
  assert.equal(t.disabled('k'), false);
}

// Default threshold is 5.
{
  const t = new FailureTracker();
  for (let i = 0; i < 4; i++) assert.equal(t.fail('k'), false);
  assert.equal(t.fail('k'), true);
}

// ── RateGate ────────────────────────────────────────────────────────────────

{
  const g = new RateGate();
  assert.equal(g.ok('p', 1000, 10_000), true);      // first call always passes
  assert.equal(g.ok('p', 1000, 10_500), false);     // 500ms later — blocked
  assert.equal(g.ok('p', 1000, 11_000), true);      // exactly minMs — passes
  assert.equal(g.ok('q', 1000, 11_100), true);      // independent key
  assert.equal(g.ok('p', 1000, 11_500), false);     // clock re-anchored at 11_000
}

// ── capEnabled ──────────────────────────────────────────────────────────────

{
  assert.equal(capEnabled({ skill: 's', seeded: true }, {}), true);            // seeded default-on
  assert.equal(capEnabled({ skill: 's', seeded: true }, { s: false }), false);
  assert.equal(capEnabled({ skill: 'c' }, {}), false);                          // custom default-off
  assert.equal(capEnabled({ skill: 'c' }, { c: true }), true);
}

console.log('plugins.test.ts: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd controller && npx tsx scripts/plugins.test.ts`
Expected: FAIL — `Cannot find module '../src/skills/plugin-pure.js'`

- [ ] **Step 3: Write the implementation**

Create `controller/src/skills/plugin-pure.ts`:

```ts
// Pure helpers for the plugin system (skills/plugin-runtime.ts) — definition
// validation, the consecutive-failure auto-disable tracker, the rate gate, and
// the shared enabled-map rule. No imports, no I/O: everything here is pinned
// by scripts/plugins.test.ts.

export const HOOK_NAMES = ['trackStarted', 'requestReceived', 'sessionRolled'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export interface PluginSchedule {
  cron: string;
  label: string | null;
  run: (...args: any[]) => any;
}

export interface PluginDefinition {
  hooks: Partial<Record<HookName, (...args: any[]) => any>>;
  schedules: PluginSchedule[];
  picker: {
    candidates: ((...args: any[]) => any) | null;
    veto: ((...args: any[]) => any) | null;
  };
}

// Normalize a plugin.mjs default export into a PluginDefinition. Lenient where
// the skills loader is lenient (unknown keys warn and drop), strict where a
// typo would otherwise fail silently on air (a declared-but-wrong handler is
// an error, not a skip). `def` is null iff there are errors OR the module
// declares no capability at all.
export function validatePluginDefinition(
  raw: unknown,
  opts: { isValidCron: (expr: string) => boolean },
): { def: PluginDefinition | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { def: null, errors: ['plugin.mjs default export must be an object'], warnings };
  }
  const obj = raw as Record<string, any>;
  const def: PluginDefinition = { hooks: {}, schedules: [], picker: { candidates: null, veto: null } };

  for (const key of Object.keys(obj)) {
    if (!['hooks', 'schedules', 'picker'].includes(key)) warnings.push(`unknown key "${key}" ignored`);
  }

  if (obj.hooks != null) {
    if (typeof obj.hooks !== 'object' || Array.isArray(obj.hooks)) {
      errors.push('hooks must be an object');
    } else {
      for (const [name, fn] of Object.entries(obj.hooks)) {
        if (!(HOOK_NAMES as readonly string[]).includes(name)) {
          warnings.push(`unknown hook "${name}" ignored (valid: ${HOOK_NAMES.join(', ')})`);
          continue;
        }
        if (typeof fn !== 'function') { errors.push(`hook "${name}" must be a function`); continue; }
        def.hooks[name as HookName] = fn as any;
      }
    }
  }

  if (obj.schedules != null) {
    if (!Array.isArray(obj.schedules)) {
      errors.push('schedules must be an array');
    } else {
      obj.schedules.forEach((s: any, i: number) => {
        if (!s || typeof s !== 'object') { errors.push(`schedules[${i}] must be an object`); return; }
        if (typeof s.cron !== 'string' || !opts.isValidCron(s.cron)) {
          errors.push(`schedules[${i}] has an invalid cron expression`); return;
        }
        if (typeof s.run !== 'function') { errors.push(`schedules[${i}] must export a run() function`); return; }
        def.schedules.push({ cron: s.cron, label: typeof s.label === 'string' ? s.label : null, run: s.run });
      });
    }
  }

  if (obj.picker != null) {
    if (typeof obj.picker !== 'object' || Array.isArray(obj.picker)) {
      errors.push('picker must be an object');
    } else {
      for (const member of ['candidates', 'veto'] as const) {
        const fn = obj.picker[member];
        if (fn == null) continue;
        if (typeof fn !== 'function') { errors.push(`picker.${member} must be a function`); continue; }
        def.picker[member] = fn;
      }
    }
  }

  if (errors.length) return { def: null, errors, warnings };
  const count = Object.keys(def.hooks).length + def.schedules.length
    + (def.picker.candidates ? 1 : 0) + (def.picker.veto ? 1 : 0);
  if (count === 0) return { def: null, errors: ['plugin.mjs declares no capabilities'], warnings };
  return { def, errors, warnings };
}

// Consecutive-failure counter with a hard disable once `threshold` is crossed.
// Keys are free-form ("<kind>:hook:<name>", "<kind>:schedule:<i>", …); a
// success resets the count for its key; reset() (on rescan) clears everything.
export class FailureTracker {
  private counts = new Map<string, number>();
  private dead = new Set<string>();
  constructor(private threshold = 5) {}

  // Record a failure. Returns true exactly once — when this failure crosses
  // the threshold — so the caller can log the auto-disable loudly.
  fail(key: string): boolean {
    if (this.dead.has(key)) return false;
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    if (n >= this.threshold) { this.dead.add(key); return true; }
    return false;
  }

  succeed(key: string): void { this.counts.delete(key); }
  disabled(key: string): boolean { return this.dead.has(key); }
  disabledKeys(prefix = ''): string[] {
    return [...this.dead].filter(k => k.startsWith(prefix)).sort();
  }
  reset(): void { this.counts.clear(); this.dead.clear(); }
}

// Minimum-gap gate: ok() returns true (and records `now`) when at least
// `minMs` has passed since the last time it returned true for this key.
export class RateGate {
  private last = new Map<string, number>();
  ok(key: string, minMs: number, now: number = Date.now()): boolean {
    const prev = this.last.get(key);
    if (prev != null && now - prev < minMs) return false;
    this.last.set(key, now);
    return true;
  }
}

// The single enabled rule (mirrors skillCatalog() in skills/_agent.ts):
// seeded built-ins are on unless explicitly off; operator skills/plugins are
// off unless explicitly on.
export function capEnabled(
  cap: { skill: string; seeded?: boolean },
  enabledMap: Record<string, boolean>,
): boolean {
  return cap.seeded ? enabledMap[cap.skill] !== false : enabledMap[cap.skill] === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd controller && npx tsx scripts/plugins.test.ts`
Expected: `plugins.test.ts: all assertions passed`

- [ ] **Step 5: Wire the npm script**

In `controller/package.json`, after the `"test:connect"` line add:

```json
    "test:plugins": "tsx scripts/plugins.test.ts",
```

Run: `cd controller && npm run test:plugins`
Expected: `plugins.test.ts: all assertions passed`

- [ ] **Step 6: Stage**

```bash
git add controller/src/skills/plugin-pure.ts controller/scripts/plugins.test.ts controller/package.json
```

---

### Task 2: Loader — import and attach `plugin.mjs`

**Files:**
- Modify: `controller/src/skills/loader.ts`

**Interfaces:**
- Consumes: `validatePluginDefinition`, `PluginDefinition` from `./plugin-pure.js` (Task 1).
- Produces (consumed by Tasks 3, 6): each loaded capability may now carry
  - `cap.plugin: PluginDefinition | undefined`
  - `cap.pluginReady: ((services: any) => boolean) | undefined` (a plugin.mjs `ready` export, used only when tool.mjs supplies none)
  - `cap.version: string | undefined`, `cap.author: string | undefined` (frontmatter, informational)
- Behavior change: a non-seeded skill with an empty SKILL.md body is accepted when a valid `plugin.mjs` loads (it has no segment; `cap.desc` stays `''`).

- [ ] **Step 1: Add the plugin module loader**

In `controller/src/skills/loader.ts`, add to the imports (`node-cron` is already a controller dependency):

```ts
import cron from 'node-cron';
import { validatePluginDefinition, type PluginDefinition } from './plugin-pure.js';
```

After `loadToolModule` (below line 294), add:

```ts
// Dynamically import a skill's optional plugin.mjs — the plugin definition
// module (hooks / schedules / picker, see docs/plugins.md). Returns null when
// there's no plugin.mjs; throws on a malformed one (the caller logs and
// degrades to a plain skill, mirroring how a broken tool.mjs degrades).
async function loadPluginModule(dir: string, slug: string): Promise<{ def: PluginDefinition; ready?: (services: any) => boolean } | null> {
  const file = join(dir, 'plugin.mjs');
  try {
    await stat(file);
  } catch {
    return null; // no plugin.mjs — a plain skill, that's fine
  }
  const url = `${pathToFileURL(file).href}?v=${++importCounter}`;
  const mod = await import(url);
  const { def, errors, warnings } = validatePluginDefinition(mod.default, { isValidCron: (e) => cron.validate(e) });
  for (const w of warnings) queue.log('error', `[skills] "${slug}" plugin.mjs: ${w}`);
  if (!def) throw new Error(errors.join('; '));
  return { def, ready: typeof mod.ready === 'function' ? mod.ready : undefined };
}
```

- [ ] **Step 2: Wire it into `loadSkillDir`**

In `loadSkillDir` (line 299), the current empty-body rejection is:

```ts
  // A seeded built-in always ships a brief; an operator skill must supply one.
  if (!seeded && !body) {
    queue.log('error', `[skills] "${slug}" rejected — SKILL.md body (the agent's brief) is empty`);
    return null;
  }
```

Replace with (the plugin load must happen first, so move it above; `requiresKey` parsing stays where it is):

```ts
  let pluginMod: { def: PluginDefinition; ready?: (services: any) => boolean } | null = null;
  try {
    pluginMod = await loadPluginModule(dir, slug);
  } catch (err: any) {
    queue.log('error', `[skills] "${slug}" plugin.mjs failed to load — running as a plain skill: ${err.message}`);
    pluginMod = null;
  }

  // A seeded built-in always ships a brief; an operator skill must supply one —
  // unless it's a plugin with no spoken segment (hooks/schedules/picker only).
  if (!seeded && !body && !pluginMod) {
    queue.log('error', `[skills] "${slug}" rejected — SKILL.md body (the agent's brief) is empty`);
    return null;
  }
```

In the `const cap: any = { … }` literal (line 329), after the `tags:` line add:

```ts
    // Informational only — shown in /admin/skills, no behavior.
    version: data.version ? String(data.version).trim() : undefined,
    author: data.author ? String(data.author).trim() : undefined,
```

After the readiness block (`if (toolMod?.ready) { … } else if (requiresKey) { … }`, line 353), extend it so a plugin `ready` slots between tool.mjs and requiresKey:

```ts
  if (toolMod?.ready) {
    cap.ready = () => toolMod.ready(buildStationServices());
  } else if (pluginMod?.ready) {
    cap.ready = () => pluginMod.ready!(buildStationServices());
  } else if (requiresKey) {
    cap.ready = () => !!process.env[requiresKey];
  }
```

And just before `return cap;` add:

```ts
  if (pluginMod) cap.plugin = pluginMod.def;
```

- [ ] **Step 3: Verify with lint + a smoke check**

Run: `cd controller && npm run lint`
Expected: clean (0 errors).

Smoke check the loader against a throwaway plugin folder (uses a temp STATE_DIR so the real one is untouched):

```bash
cd controller && rm -rf /tmp/pstest && mkdir -p /tmp/pstest/skills/pl-test && \
printf -- '---\nname: pl-test\n---\n' > /tmp/pstest/skills/pl-test/SKILL.md && \
printf 'export default { hooks: { trackStarted: async () => {} } };\n' > /tmp/pstest/skills/pl-test/plugin.mjs && \
STATE_DIR=/tmp/pstest npx tsx -e "const { loadSkills } = await import('./src/skills/loader.js'); const caps = await loadSkills(); const p = caps.find(c => c.kind === 'pl-test'); console.log('plugin loaded:', !!p, 'hooks:', p ? Object.keys(p.plugin?.hooks || {}) : null);"
```

Expected output ends with: `plugin loaded: true hooks: [ 'trackStarted' ]`
(An empty-body, plugin-only skill loads — the Task 2 behavior change.)

- [ ] **Step 4: Stage**

```bash
git add controller/src/skills/loader.ts
```

---

### Task 3: Runtime — `plugin-runtime.ts` (dispatch, schedules, ctx, actions)

**Files:**
- Create: `controller/src/skills/plugin-runtime.ts`
- Modify: `controller/src/skills/loader.ts` (init + rebuild call in `loadSkills`)

**Interfaces:**
- Consumes: `FailureTracker`, `RateGate`, `capEnabled`, `HOOK_NAMES`, `HookName`, `PluginDefinition` (Task 1); `cap.plugin` (Task 2); `settings.get()` (`../settings.js`); `optionalSegmentsAllowed()` (`../broadcast/dj-budget.js`); `getSong(id)` (`../music/subsonic.js`).
- Produces (consumed by Tasks 4, 5, 6):
  - `initPluginRuntime(deps: { queue: any; services: any }): void` — called once by the loader; queue and station-services are INJECTED so this module never top-level-imports the queue chain (session.ts may then import it without a cycle)
  - `rebuildPluginRuntime(caps: any[]): void` — called at the end of every `loadSkills()`
  - `emitStationEvent(name: HookName, ev: any): void` — fire-and-forget, setImmediate-deferred
  - `pluginPickerSources(ctx: any): Promise<{ label: string; items: any[] }[]>` — ≤5 items per plugin, label `plugin:<slug>`
  - `pluginPickerVetoes(ctx: any, candidates: any[]): Promise<Set<string>>` — union of vetoed ids
  - `pluginStatus(kind: string): { hooks: string[]; schedules: number; picker: { candidates: boolean; veto: boolean }; autoDisabled: string[] } | null` — null for non-plugin kinds

- [ ] **Step 1: Write the module**

Create `controller/src/skills/plugin-runtime.ts`:

```ts
// Plugin runtime — everything DYNAMIC about plugins (skills that ship a
// plugin.mjs, see docs/plugins.md). Owns hook dispatch, the cron schedule
// registry, plugin ctx construction (services facade + gated actions), and
// per-capability failure accounting with auto-disable.
//
// DEPENDENCY DISCIPLINE: `queue` and the station-services facade are INJECTED
// via initPluginRuntime (called by skills/loader.ts, which legitimately
// imports both). This module must NOT top-level-import queue.js or
// station-services.js — session.ts imports emitStationEvent from here, and
// session must stay free of the queue import chain (see session.ts's
// stampRolledFrom comment). settings/dj-budget/subsonic are safe: none of
// them pull queue.
import cron from 'node-cron';
import { settings } from '../settings.js';
import { optionalSegmentsAllowed } from '../broadcast/dj-budget.js';
import { getSong } from '../music/subsonic.js';
import {
  FailureTracker, RateGate, capEnabled, HOOK_NAMES, type HookName, type PluginDefinition,
} from './plugin-pure.js';

const HOOK_TIMEOUT_MS = 8000;
const PICKER_TIMEOUT_MS = 4000;
const SCHEDULE_FLOOR_MS = 5 * 60_000;
const ANNOUNCE_FLOOR_MS = 5 * 60_000;
const CANDIDATES_PER_PLUGIN = 5;
const PENDING_TRACKS_PER_PLUGIN = 2;

interface RuntimeDeps { queue: any; services: any }

let deps: RuntimeDeps | null = null;
let plugins: any[] = []; // capabilities that carry cap.plugin
let scheduleTasks: { stop: () => void }[] = [];
const failures = new FailureTracker(5);
const announceGate = new RateGate();
const scheduleGate = new RateGate();

export function initPluginRuntime(d: RuntimeDeps): void { deps = d; }

// Rebuild from the freshly loaded capability set — called at the end of every
// loadSkills() (boot and every rescan). Destroys and re-registers cron schedules;
// clears failure state (a rescan is the operator's "try again").
export function rebuildPluginRuntime(caps: any[]): void {
  for (const t of scheduleTasks) { try { t.stop(); } catch {} }
  scheduleTasks = [];
  failures.reset();
  plugins = caps.filter(c => c?.plugin);
  if (!deps) return;
  for (const cap of plugins) {
    (cap.plugin as PluginDefinition).schedules.forEach((sched, i) => {
      const task = cron.schedule(sched.cron, () => { void runSchedule(cap, sched, i); });
      scheduleTasks.push(task);
    });
  }
  if (plugins.length) {
    const n = plugins.reduce((a, c) => a + (c.plugin as PluginDefinition).schedules.length, 0);
    deps.queue.log('scheduler', `[plugins] ${plugins.length} plugin(s) active, ${n} schedule(s)`);
  }
}

function enabled(cap: any): boolean {
  return capEnabled(cap, settings.get().skills?.enabled || {});
}

// Ready gate mirrors the segment director's: a cap.ready() that returns false
// (missing key, sidecar down) keeps hooks/schedules/picker inert too.
function ready(cap: any): boolean {
  try { return typeof cap.ready === 'function' ? !!cap.ready() : true; } catch { return false; }
}

function runnable(cap: any): boolean { return enabled(cap) && ready(cap); }

async function fenced<T>(cap: any, key: string, label: string, ms: number, fn: () => Promise<T>): Promise<T | null> {
  if (failures.disabled(key)) return null;
  try {
    const out = await withTimeout(Promise.resolve(fn()), ms);
    failures.succeed(key);
    return out;
  } catch (err: any) {
    const justDied = failures.fail(key);
    deps!.queue.log('error', `[plugin:${cap.kind}] ${label} failed: ${err?.message || err}` +
      (justDied ? ' — auto-disabled until the next rescan' : ''));
    return null;
  }
}

// ── hooks ───────────────────────────────────────────────────────────────────

// Fire-and-forget: emit points sit on hot paths (track watcher, request flow,
// session roll) and must never await plugin code. Handlers run sequentially
// per event, each behind the segment-tools-style timeout + try/catch.
export function emitStationEvent(name: HookName, ev: any): void {
  if (!deps || !plugins.length) return;
  if (!(HOOK_NAMES as readonly string[]).includes(name)) return;
  setImmediate(async () => {
    for (const cap of plugins) {
      const fn = (cap.plugin as PluginDefinition).hooks[name];
      if (!fn || !runnable(cap)) continue;
      await fenced(cap, `${cap.kind}:hook:${name}`, `${name} hook`, HOOK_TIMEOUT_MS,
        () => fn(buildPluginContext(cap), ev));
    }
  });
}

// ── schedules ───────────────────────────────────────────────────────────────

async function runSchedule(cap: any, sched: PluginDefinition['schedules'][number], i: number): Promise<void> {
  if (!deps || !runnable(cap)) return;
  // Rate floor: a schedule can't run more often than every 5 minutes, however
  // aggressive its cron expression.
  if (!scheduleGate.ok(`${cap.kind}:${i}`, SCHEDULE_FLOOR_MS)) {
    deps.queue.log('scheduler', `[plugin:${cap.kind}] schedule ${sched.label || i} skipped (rate floor)`);
    return;
  }
  await fenced(cap, `${cap.kind}:schedule:${i}`, `schedule ${sched.label || i}`, HOOK_TIMEOUT_MS,
    () => sched.run(buildPluginContext(cap)));
}

// ── picker seams ────────────────────────────────────────────────────────────

// Candidate contributions for the pool picker: one fenced call per enabled
// plugin, first CANDIDATES_PER_PLUGIN results each, stamped for the pool's
// source accounting. Returns [] when no plugin contributes.
export async function pluginPickerSources(ctx: any): Promise<{ label: string; items: any[] }[]> {
  if (!deps) return [];
  const out: { label: string; items: any[] }[] = [];
  for (const cap of plugins) {
    const fn = (cap.plugin as PluginDefinition).picker.candidates;
    if (!fn || !runnable(cap)) continue;
    const items = await fenced(cap, `${cap.kind}:picker:candidates`, 'picker.candidates', PICKER_TIMEOUT_MS,
      () => fn(buildPluginContext(cap), { ctx }));
    if (Array.isArray(items) && items.length) {
      out.push({ label: `plugin:${cap.kind}`, items: items.slice(0, CANDIDATES_PER_PLUGIN) });
    }
  }
  return out;
}

// Veto pass: each plugin sees the FULL candidate list once and returns ids to
// drop. The union is returned; the caller owns the never-empty guard.
export async function pluginPickerVetoes(ctx: any, candidates: any[]): Promise<Set<string>> {
  const vetoed = new Set<string>();
  if (!deps) return vetoed;
  for (const cap of plugins) {
    const fn = (cap.plugin as PluginDefinition).picker.veto;
    if (!fn || !runnable(cap)) continue;
    const ids = await fenced(cap, `${cap.kind}:picker:veto`, 'picker.veto', PICKER_TIMEOUT_MS,
      () => fn(buildPluginContext(cap), candidates));
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && id) vetoed.add(id);
  }
  return vetoed;
}

// ── ctx & actions ───────────────────────────────────────────────────────────

// The plugin's view of the station: the read-mostly services facade every
// tool.mjs already gets, plus a namespaced log and the two gated actions.
function buildPluginContext(cap: any): any {
  return {
    ...deps!.services,
    log: (msg: string) => deps!.queue.log('scheduler', `[plugin:${cap.kind}] ${msg}`),
    actions: {
      // Speak. Rides the plugin's own kind (registered via registerSkillKinds,
      // so the voice serializer / session log / anti-repeat all apply). Gated:
      // budget (optionalSegmentsAllowed — plugin voice mutes under pressure
      // like every optional segment) and the plugin's cooldown (frontmatter
      // `cooldown:`, floored at 5 min). Returns { aired, reason }.
      announce: async (text: string, { atNextTrack = false }: { atNextTrack?: boolean } = {}) => {
        const t = String(text || '').trim();
        if (!t) return { aired: false, reason: 'empty text' };
        if (!enabled(cap)) return { aired: false, reason: 'plugin disabled' };
        if (!optionalSegmentsAllowed()) return { aired: false, reason: 'daily token budget' };
        const coolMs = Math.max(cap.cooldownMs || 0, ANNOUNCE_FLOOR_MS);
        if (!announceGate.ok(cap.kind, coolMs)) return { aired: false, reason: 'announce cooldown' };
        if (atNextTrack) await deps!.queue.announceAtNextTrack(t, cap.kind);
        else await deps!.queue.announce(t, cap.kind);
        return { aired: true };
      },
      // Queue a library track by subsonic id. Gated on the pending cap;
      // dedup + never-play blocklist apply inside queue.push. Returns
      // { queued, reason }.
      queueTrack: async (songId: string, { intro = null }: { intro?: string | null } = {}) => {
        if (!enabled(cap)) return { queued: false, reason: 'plugin disabled' };
        const tag = `plugin:${cap.kind}`;
        const pending = deps!.queue.upcoming.filter((u: any) => u.requestedBy === tag).length;
        if (pending >= PENDING_TRACKS_PER_PLUGIN) return { queued: false, reason: `already ${pending} pending` };
        const song = await getSong(String(songId));
        if (!song) return { queued: false, reason: `no song with id ${songId}` };
        const idx = await deps!.queue.push({ track: song, requestedBy: tag, introScript: intro || null });
        if (idx === -1) return { queued: false, reason: 'duplicate or blocklisted' };
        return { queued: true };
      },
    },
  };
}

// ── admin surface ───────────────────────────────────────────────────────────

// Capability metadata + live auto-disable state for skillCatalog(); null for
// kinds that aren't plugins.
export function pluginStatus(kind: string): {
  hooks: string[]; schedules: number;
  picker: { candidates: boolean; veto: boolean }; autoDisabled: string[];
} | null {
  const cap = plugins.find(c => c.kind === kind);
  if (!cap) return null;
  const def = cap.plugin as PluginDefinition;
  return {
    hooks: Object.keys(def.hooks),
    schedules: def.schedules.length,
    picker: { candidates: !!def.picker.candidates, veto: !!def.picker.veto },
    // "trackStarted hook", "schedule 0", … — human-readable suffixes.
    autoDisabled: failures.disabledKeys(`${kind}:`).map(k => k.slice(kind.length + 1).replace(':', ' ')),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`plugin timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}
```

- [ ] **Step 2: Init + rebuild from the loader**

In `controller/src/skills/loader.ts` add to imports:

```ts
import { initPluginRuntime, rebuildPluginRuntime } from './plugin-runtime.js';
```

In `loadSkills()` (line 377), after `registerSkillKinds(out.map(c => c.kind));` add:

```ts
  // Hand the fresh capability set to the plugin runtime: (re)registers cron
  // schedules, clears failure/auto-disable state. Injects queue + services on
  // first call (this module legitimately imports both; plugin-runtime must not).
  initPluginRuntime({ queue, services: buildStationServices() });
  rebuildPluginRuntime(out);
```

Also add `rebuildPluginRuntime([])` right after `registerSkillKinds([]);` in the early-return branch (no skills dir), so a wiped state dir also clears schedules.

- [ ] **Step 3: Verify**

Run: `cd controller && npm run lint`
Expected: clean.

Runtime smoke (temp STATE_DIR; exercises load → rebuild → emit → hook ran):

```bash
cd controller && rm -rf /tmp/pstest && mkdir -p /tmp/pstest/skills/pl-test && \
printf -- '---\nname: pl-test\n---\n' > /tmp/pstest/skills/pl-test/SKILL.md && \
printf 'export default { hooks: { trackStarted: async (ctx, ev) => ctx.log(`saw ${ev.track.title}`) } };\n' > /tmp/pstest/skills/pl-test/plugin.mjs && \
STATE_DIR=/tmp/pstest npx tsx -e "
const { loadSkills } = await import('./src/skills/loader.js');
const { emitStationEvent } = await import('./src/skills/plugin-runtime.js');
const { settings } = await import('./src/settings.js');
await loadSkills();
await settings.update({ skills: { enabled: { 'pl-test': true } } });
emitStationEvent('trackStarted', { track: { title: 'Test Song' }, previous: null });
await new Promise(r => setTimeout(r, 300));
"
```

Expected: output includes a log line containing `[plugin:pl-test] saw Test Song`.

- [ ] **Step 4: Stage**

```bash
git add controller/src/skills/plugin-runtime.ts controller/src/skills/loader.ts
```

---

### Task 4: Emit points — queue, dj-agent, session

**Files:**
- Modify: `controller/src/broadcast/queue.ts` (end of `onTrackStarted`, line ~1180)
- Modify: `controller/src/broadcast/dj-agent.ts` (top of `runRequest`, line ~929)
- Modify: `controller/src/broadcast/session.ts` (hard-roll branch of `maybeRoll`, line ~270)

**Interfaces:**
- Consumes: `emitStationEvent(name, ev)` from `../skills/plugin-runtime.js` (Task 3). Safe to import from all three files: plugin-runtime has no top-level import of queue/station-services (see Task 3 header comment).
- Produces: the three spec'd events with payloads `{ track, previous }`, `{ requester, text }`, `{ fromKey, toKey, show }`.

- [ ] **Step 1: `trackStarted` in queue.ts**

Add to `controller/src/broadcast/queue.ts` imports:

```ts
import { emitStationEvent } from '../skills/plugin-runtime.js';
```

At the END of the `onTrackStarted(np)` method body (after both the matched and untracked branches have set `this.current`; before the method's closing brace), add:

```ts
    // Plugin hook: a new track is on air. Fire-and-forget (setImmediate inside)
    // — must not stall the watcher tick, same rule as airPendingVoice above.
    emitStationEvent('trackStarted', {
      track: this.current?.track
        ?? { id: np.subsonic_id || null, title: np.title, artist: np.artist || null },
      previous: outgoingPrev?.track ?? null,
    });
```

- [ ] **Step 2: `requestReceived` in dj-agent.ts**

Add to `controller/src/broadcast/dj-agent.ts` imports:

```ts
import { emitStationEvent } from '../skills/plugin-runtime.js';
```

At the top of `runRequest` (line 929), BEFORE the `if (!settings.get().llm?.pickerAgent || breakerOpen()) return null;` early return, add:

```ts
  // Plugin hook: a listener request arrived — fires for BOTH resolution paths
  // (agent and the caller's stateless-matcher fallback), since every request
  // passes through here before any early return.
  emitStationEvent('requestReceived', { requester, text });
```

- [ ] **Step 3: `sessionRolled` in session.ts**

Add to `controller/src/broadcast/session.ts` imports (this does NOT violate session's no-queue-imports rule — plugin-runtime's queue handle is injected, not imported):

```ts
import { emitStationEvent } from '../skills/plugin-runtime.js';
```

In `maybeRoll` (line 270), the hard-roll branch currently ends:

```ts
  const prev = _session;
  await end();
  const next = start(ctx, buildHandoff(prev));
  stampRolledFrom(next, prev);
  await persist();
  return next;
```

Add the emit before `return next;`:

```ts
  // Plugin hook: a hard session roll — a show boundary or the 4h age cap.
  // (Soft shifts within an auto run are NOT rolls and don't fire this.)
  emitStationEvent('sessionRolled', {
    fromKey: prev.key,
    toKey: next.key,
    show: (ctx as any)?.activeShow ?? null,
  });
```

- [ ] **Step 4: Verify**

Run: `cd controller && npm run lint`
Expected: clean. (The hook behavior itself was smoke-tested in Task 3; these are one-line call sites.)

- [ ] **Step 5: Stage**

```bash
git add controller/src/broadcast/queue.ts controller/src/broadcast/dj-agent.ts controller/src/broadcast/session.ts
```

---

### Task 5: Picker seams — candidates into the pool, veto with never-empty guard

**Files:**
- Modify: `controller/src/music/picker.ts` (`buildCandidates` line 178, `pickViaPool` lines 556–600)

**Interfaces:**
- Consumes: `pluginPickerSources(ctx)`, `pluginPickerVetoes(ctx, candidates)` from `../skills/plugin-runtime.js` (Task 3).
- Produces: plugin candidates enter the pool THROUGH `buildCandidates` (so the shared dedup / artist-cap / recency filtering applies to them, per spec) with `_source: 'plugin:<slug>'` visible in the pool log line; vetoes apply after the excluded-playlist filter and are discarded if they would empty the pool.

- [ ] **Step 1: Thread plugin sources into `buildCandidates`**

In `controller/src/music/picker.ts`, add to imports:

```ts
import { pluginPickerSources, pluginPickerVetoes } from '../skills/plugin-runtime.js';
```

Extend `buildCandidates`'s signature (line 178) with a final parameter:

```ts
async function buildCandidates(mood, recentIds, recentArtists, currentTrack, rankTarget = null, audioWaypoint = null, showFilter = null, hardRecentIds = new Set(), hardRecentKeys = new Set(), playlistPool = null, playlistStrict = false, pluginSources: { label: string; items: any[] }[] = []) {
```

(Keep the existing TypeScript annotations on the earlier params exactly as they are — only append `, pluginSources: { label: string; items: any[] }[] = []`.)

Inside `buildCandidates`, immediately AFTER the "7. Fallback if the pool is still thin" block (after line 454's closing `}`), add:

```ts
  // Plugin-contributed candidates (≤5 each, already fenced + capped by the
  // runtime). Added through add() so they get the same dedup / artist-cap /
  // recency treatment as every built-in source, and show up in the pool log.
  for (const ps of pluginSources) add(ps.label, ps.items);
```

- [ ] **Step 2: Call the seams from `pickViaPool`**

In `pickViaPool` (line 556), just before the `buildCandidates` call (line 590), add:

```ts
  const pluginSources = await pluginPickerSources(ctx);
```

and append `pluginSources` as the final argument of the `buildCandidates(...)` call:

```ts
  const { candidates: rawCandidates, sources, strictInfo, playlistInfo } = await buildCandidates(ctx.dominantMood, recentIds, recentArtists, currentTrack, rankTarget, audioWaypoint, showFilter, hardRecentIds, hardRecentKeys, playlistPool, playlistStrict, pluginSources);
```

Then change the excluded-filter block (lines 595–597) from `const candidates = …` to `let candidates = …`, and add the veto pass directly after it (before the `if (candidates.length === 0)` check at line 599):

```ts
  let candidates = excludedIds
    ? rawCandidates.filter((t) => t?.id && !excludedIds.has(t.id))
    : rawCandidates;

  // Plugin veto pass: each plugin sees the full list once, returns ids to
  // drop. Never-empty guard: a veto set that would silence the station is
  // discarded (logged) — a plugin must not be able to stop the music.
  const vetoedIds = await pluginPickerVetoes(ctx, candidates);
  if (vetoedIds.size) {
    const kept = candidates.filter((t) => !t?.id || !vetoedIds.has(t.id));
    if (kept.length === 0) {
      queue.log('picker', `plugin veto would empty the pool (${vetoedIds.size} id(s)) — ignored`);
    } else if (kept.length < candidates.length) {
      queue.log('picker', `plugin veto dropped ${candidates.length - kept.length} candidate(s)`);
      candidates = kept;
    }
  }
```

- [ ] **Step 3: Verify**

Run: `cd controller && npm run lint`
Expected: clean.

Run the existing picker regression test (guards the recency behavior the new params thread through):

```bash
cd controller && npx tsx scripts/picker-recency-regression.test.ts
```

Expected: passes (its existing final output line, no assertion failures).

- [ ] **Step 4: Stage**

```bash
git add controller/src/music/picker.ts
```

---

### Task 6: Admin surface — catalogue metadata + Skills page badges

**Files:**
- Modify: `controller/src/skills/_agent.ts` (`skillCatalog()`, line 717)
- Modify: `web/components/admin/SkillsPanel.tsx` (Skill type ~line 40, card render ~line 566)

**Interfaces:**
- Consumes: `pluginStatus(kind)` from `./plugin-runtime.js` (Task 3); `cap.version` / `cap.author` (Task 2).
- Produces: each `skillCatalog()` entry gains `plugin: { hooks: string[]; schedules: number; picker: { candidates: boolean; veto: boolean }; autoDisabled: string[] } | null`, `version: string | null`, `author: string | null`. The web UI renders a `plugin` pill, a capability summary line, an auto-disabled warning, and version/author.

- [ ] **Step 1: Extend `skillCatalog()`**

In `controller/src/skills/_agent.ts`, add to imports:

```ts
import { pluginStatus } from './plugin-runtime.js';
```

In the object returned by the `allCapabilities().map(c => { … return { … } })` inside `skillCatalog()` (line 745), add after the `custom: !c.seeded,` line:

```ts
      // Plugin capability metadata + live auto-disable state (null for plain
      // skills). Drives the /admin/skills badges.
      plugin: pluginStatus(c.kind),
      version: c.version || null,
      author: c.author || null,
```

Run: `cd controller && npm run lint` — expected clean.

- [ ] **Step 2: Extend the web Skill type**

In `web/components/admin/SkillsPanel.tsx`, in the `Skill` type (the block containing `custom?: boolean;` at line 40), add:

```ts
  plugin?: {
    hooks: string[];
    schedules: number;
    picker: { candidates: boolean; veto: boolean };
    autoDisabled: string[];
  } | null;
  version?: string | null;
  author?: string | null;
```

- [ ] **Step 3: Render badges + warning**

In the card `right={…}` fragment (line 570, next to `{s.custom && <Pill>custom</Pill>}`), add:

```tsx
              {s.plugin && <Pill tone="accent">plugin</Pill>}
```

In the card BODY, directly above the existing `{s.ready === false && (` block (line 583), add:

```tsx
          {s.plugin && (
            <div className="mb-2 text-[12px] text-muted">
              Plugin
              {s.version ? ` v${s.version}` : ''}
              {s.author ? ` by ${s.author}` : ''}
              {' — '}
              {[
                s.plugin.hooks.length ? `hooks: ${s.plugin.hooks.join(', ')}` : null,
                s.plugin.schedules ? `${s.plugin.schedules} schedule${s.plugin.schedules === 1 ? '' : 's'}` : null,
                (s.plugin.picker.candidates || s.plugin.picker.veto)
                  ? `picker (${[s.plugin.picker.candidates && 'candidates', s.plugin.picker.veto && 'veto'].filter(Boolean).join(' + ')})`
                  : null,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
          {s.plugin && s.plugin.autoDisabled.length > 0 && (
            <div className="mb-3">
              <V3Alert tone="error" title="Capabilities auto-disabled">
                Repeated failures auto-disabled: {s.plugin.autoDisabled.join(', ')}.
                Fix the plugin code, then Rescan to re-arm.
              </V3Alert>
            </div>
          )}
```

- [ ] **Step 4: Verify**

Run: `cd web && npm run lint`
Expected: clean.

(Do NOT run `npm run build` in `web/` — it clobbers a running dev server's `.next`.)

- [ ] **Step 5: Stage**

```bash
git add controller/src/skills/_agent.ts web/components/admin/SkillsPanel.tsx
```

---

### Task 7: Docs + two example plugins

**Files:**
- Create: `docs/plugins.md`
- Create: `docs/examples/plugins/play-milestones/SKILL.md`
- Create: `docs/examples/plugins/play-milestones/plugin.mjs`
- Create: `docs/examples/plugins/friday-kickoff/SKILL.md`
- Create: `docs/examples/plugins/friday-kickoff/plugin.mjs`
- Modify: `docs/custom-skills.md` (cross-link near the top)

**Interfaces:**
- Consumes: the full contract from Tasks 1–6. The examples are the manual-verification vehicles for Task 8.

- [ ] **Step 1: Write `docs/plugins.md`**

```markdown
# Plugins

A **plugin** is a skill folder that does more than speak. Alongside (or instead
of) the between-track segment described in [custom-skills.md](./custom-skills.md),
a plugin can react to station events, run on its own schedule, and nudge track
selection — by adding one file, `plugin.mjs`, next to `SKILL.md`:

```
state/skills/
  play-milestones/
    SKILL.md      # manifest (frontmatter) + OPTIONAL segment brief (body)
    tool.mjs      # OPTIONAL: segment data fetcher (see custom-skills.md)
    plugin.mjs    # the plugin definition
```

With a valid `plugin.mjs`, the SKILL.md body may be empty — the plugin simply
has no spoken segment. Everything else about skills applies unchanged: drop the
folder in, hit **Rescan** in `/admin/skills`, enable the toggle. Plugins arrive
**disabled**, like every operator skill.

## plugin.mjs

```js
export default {
  hooks: {
    // all optional; async; each call runs behind an 8s timeout + try/catch
    trackStarted:    async (ctx, ev) => {},  // ev: { track, previous }
    requestReceived: async (ctx, ev) => {},  // ev: { requester, text }
    sessionRolled:   async (ctx, ev) => {},  // ev: { fromKey, toKey, show }
  },
  schedules: [
    // node-cron expressions; runs rate-limited to at most one per 5 minutes
    { cron: '0 18 * * 5', label: 'friday kickoff', run: async (ctx) => {} },
  ],
  picker: {
    // contribute up to 5 candidates to the pool picker (see limits below)
    candidates: async (ctx) => [/* song objects with at least an id */],
    // one call per pick with the FULL candidate list; return ids to drop
    veto: async (ctx, candidates) => [/* subsonic ids */],
  },
};

// OPTIONAL, same contract as tool.mjs: gate availability (e.g. on an API key)
export const ready = (services) => true;
```

Every section is optional, but the module must declare at least one capability.

## ctx

Handlers receive the same read-mostly services facade a segment `tool.mjs`
gets (`nowPlaying()`, `recentPlays(hours)`, `library.getArtist/getAlbum/
searchArtists`, `searchWeb`, `fetchHeadlines`, `onThisDay`, `recall.seen/
remember`), plus:

- `ctx.log(msg)` — a namespaced line in the station event log.
- `ctx.actions.announce(text, { atNextTrack })` → `{ aired, reason }` — the DJ
  speaks. Gated: the plugin's enable toggle, the daily token budget
  (`optionalSegmentsAllowed` — plugin voice mutes under pressure like every
  optional segment), and the plugin's `cooldown:` frontmatter (floor 5 min).
- `ctx.actions.queueTrack(songId, { intro })` → `{ queued, reason }` — queue a
  library track. Capped at 2 pending per plugin; the never-play blocklist and
  duplicate guard apply.

A gated call returns `{ aired: false, reason }` — it never throws.

## Safety model

`plugin.mjs` is **your own code running in the controller**, exactly like a
`tool.mjs` — there is no sandbox. The fencing (timeouts, try/catch,
auto-disable after 5 consecutive failures, the veto never-empty guard, rate
floors) protects the broadcast from *accidents*, not from hostile code. Don't
install plugins you haven't read.

## Limits worth knowing

- Picker influence applies to the **pool picker** only. The default agent-mode
  picker selects via its own tools; plugin candidates/vetoes take effect when
  the pool path runs (agent off, budget-soft, breaker open, or agent failure).
- Auto-disabled capabilities re-arm on **Rescan** (or a controller restart).
- Copy-ready examples: [`docs/examples/plugins/`](./examples/plugins/).
```

- [ ] **Step 2: Write the play-milestones example**

`docs/examples/plugins/play-milestones/SKILL.md`:

```markdown
---
name: play-milestones
label: Play milestones
version: 1.0.0
author: subwave
cooldown: 30m
---
```

`docs/examples/plugins/play-milestones/plugin.mjs`:

```js
// Counts plays via the trackStarted hook (durable across restarts via the
// recall ledger) and has the DJ mark every 100th track of the day on air.
// Hook-only plugin: the SKILL.md body is empty — there is no between-track
// segment, so nothing here competes with the segment director.

const KEY = () => `play-milestones:${new Date().toISOString().slice(0, 10)}`;

let count = 0;
let day = '';

export default {
  hooks: {
    trackStarted: async (ctx, ev) => {
      const today = new Date().toISOString().slice(0, 10);
      if (day !== today) { day = today; count = 0; }
      count += 1;
      if (count > 0 && count % 100 === 0 && !ctx.recall.seen(`${KEY()}:${count}`)) {
        ctx.recall.remember(`${KEY()}:${count}`);
        const res = await ctx.actions.announce(
          `That was track number ${count} today — ${ev.track?.title || 'this one'} keeping the run alive.`,
        );
        ctx.log(`milestone ${count}: ${res.aired ? 'aired' : `held (${res.reason})`}`);
      }
    },
  },
};
```

- [ ] **Step 3: Write the friday-kickoff example**

`docs/examples/plugins/friday-kickoff/SKILL.md`:

```markdown
---
name: friday-kickoff
label: Friday kickoff
version: 1.0.0
author: subwave
cooldown: 6h
---
```

`docs/examples/plugins/friday-kickoff/plugin.mjs`:

```js
// Friday 18:00 station time: queue one starred track and announce the weekend.
// Schedule-only plugin — exercises schedules + queueTrack + announce.

export default {
  schedules: [
    {
      cron: '0 18 * * 5',
      label: 'friday kickoff',
      run: async (ctx) => {
        const recent = ctx.recentPlays(12);
        // Find a starred artist's top pick that hasn't aired in 12h.
        const artists = await ctx.library.searchArtists('');
        for (const a of (artists || []).slice(0, 10)) {
          const art = await ctx.library.getArtist(a.id).catch(() => null);
          const song = art?.topSongs?.find((s) => s?.id && !recent.ids.has(s.id));
          if (!song) continue;
          const q = await ctx.actions.queueTrack(song.id, {
            intro: 'Six o’clock on a Friday — the weekend starts right here.',
          });
          ctx.log(`kickoff ${q.queued ? `queued ${song.title}` : `held (${q.reason})`}`);
          return;
        }
        ctx.log('kickoff found nothing fresh to queue');
      },
    },
  ],
};
```

- [ ] **Step 4: Cross-link from custom-skills.md**

In `docs/custom-skills.md`, after the first paragraph (which ends `…or by dropping a folder into \`state/skills/\`.`), add:

```markdown
> Skills can also go beyond speaking: add a `plugin.mjs` to the same folder and
> the skill becomes a **plugin** — event hooks, cron schedules, picker
> influence, and queue/announce actions. See [plugins.md](./plugins.md).
```

- [ ] **Step 5: Stage**

```bash
git add docs/plugins.md docs/examples/plugins docs/custom-skills.md
```

---

### Task 8: End-to-end verification, commit, push, draft PR

**Files:** none new — verification + shipping.

- [ ] **Step 1: Full test + lint sweep**

```bash
cd controller && npm run test:plugins && npm run lint
cd ../web && npm run lint
```

Expected: `plugins.test.ts: all assertions passed`; both lints clean.

- [ ] **Step 2: End-to-end smoke with a real example plugin**

Install the play-milestones example into a temp STATE_DIR, load, enable, emit 100 synthetic trackStarted events, and confirm the milestone announce is attempted (it will report `aired:false` reasons in a bare environment — the assertion is that the hook RAN and the gate REPLIED, not that TTS rendered):

```bash
cd controller && rm -rf /tmp/pstest && mkdir -p /tmp/pstest/skills && \
cp -r ../docs/examples/plugins/play-milestones /tmp/pstest/skills/ && \
STATE_DIR=/tmp/pstest npx tsx -e "
const { loadSkills } = await import('./src/skills/loader.js');
const { emitStationEvent, pluginStatus } = await import('./src/skills/plugin-runtime.js');
const { settings } = await import('./src/settings.js');
await loadSkills();
await settings.update({ skills: { enabled: { 'play-milestones': true } } });
console.log('status:', JSON.stringify(pluginStatus('play-milestones')));
for (let i = 0; i < 100; i++) {
  emitStationEvent('trackStarted', { track: { title: 'T' + i }, previous: null });
  await new Promise(r => setTimeout(r, 5));
}
await new Promise(r => setTimeout(r, 500));
"
```

Expected: `status: {"hooks":["trackStarted"],"schedules":0,...}` and a log line containing `[plugin:play-milestones] milestone 100:` (aired or held — either proves the whole chain).

- [ ] **Step 3: Commit everything (single commit, per operator preference)**

```bash
git add -A ':!docs/superpowers'
git add docs/superpowers/specs/2026-07-12-plugin-system-design.md docs/superpowers/plans/2026-07-12-plugin-system.md
git commit -m "feat(skills): plugin system — hooks, schedules, picker influence, queue/announce actions

A skill folder may now ship a plugin.mjs declaring event hooks (trackStarted /
requestReceived / sessionRolled), cron schedules, and picker candidates/veto,
with gated announce/queueTrack actions. In-process, fenced (8s timeouts,
auto-disable after 5 consecutive failures, veto never-empty guard, rate
floors), riding the existing enable toggle, budget gates, dedup and blocklist.
Skills are unchanged — a skill is a segment-only plugin."
```

- [ ] **Step 4: Push + draft PR to develop**

```bash
git push -u origin worktree-plugin-system-design
gh pr create --draft --base develop --title "feat(skills): plugin system (hooks, schedules, picker influence, actions)" --body "$(cat <<'EOF'
## What

A skill folder may now ship a `plugin.mjs` next to `SKILL.md`, turning it into a **plugin**: event hooks (`trackStarted` / `requestReceived` / `sessionRolled`), node-cron schedules, picker candidates/veto, and gated `announce` / `queueTrack` actions. Skills are unchanged — a skill is a segment-only plugin; same load root, same toggle, same trust model.

Spec: `docs/superpowers/specs/2026-07-12-plugin-system-design.md`
Plan: `docs/superpowers/plans/2026-07-12-plugin-system.md`

## How

- `skills/plugin-pure.ts` — validation + failure/rate state machines (pinned by `npm run test:plugins`)
- `skills/plugin-runtime.ts` — hook dispatch, schedule registry, plugin ctx (services facade + gated actions), auto-disable after 5 consecutive failures; queue/services injected by the loader so session.ts can import `emitStationEvent` without a queue cycle
- Emit points: `queue.onTrackStarted`, `dj-agent.runRequest`, `session.maybeRoll`
- Picker: plugin candidates flow through `buildCandidates` (same dedup/artist-cap/recency as built-in sources); veto pass with a never-empty guard
- Admin: capability badges + auto-disabled warning on `/admin/skills`
- Docs: `docs/plugins.md` + two copy-ready examples under `docs/examples/plugins/`

## Safety

In-process by design (same trust model as `tool.mjs`): 8s/4s timeouts, per-capability auto-disable, 5-min schedule/announce floors, `optionalSegmentsAllowed()` budget gate on plugin voice, pending-track cap, blocklist/dedup via `queue.push`. Picker influence is pool-path only (documented).
EOF
)"
```

Expected: PR URL printed. Done.

---

## Self-review notes (already applied)

- Spec coverage: format/contract (T1–T2), runtime+actions+safety (T3), emit points (T4), picker seams incl. never-empty guard and agent-mode limitation—doc'd (T5, T7), admin catalogue+badges (T6), docs+examples (T7), tests (T1, T8). Community catalog: untouched (no task needed — spec says unchanged).
- Type consistency: `pluginStatus` (not `pluginRuntimeStatus`) everywhere; `pluginPickerSources`/`pluginPickerVetoes` names match between T3 and T5; `cap.plugin`/`cap.version`/`cap.author` match between T2 and T6.
- All code blocks are paste-ready; no placeholders remain.
