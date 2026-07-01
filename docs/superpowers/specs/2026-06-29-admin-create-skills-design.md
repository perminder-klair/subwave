# Create custom skills from the admin UI — design

**Date:** 2026-06-29
**Branch:** `worktree-admin-create-skills`
**Issue/ask:** `/admin/skills` has no way to *create* a skill. Custom skills can
only be made by dropping `state/skills/<slug>/SKILL.md` on disk and hitting
Rescan. Make it work like Themes / Shows / Personas — create, edit, delete from
the UI.

## Goal

Give **custom** skills full create / edit / delete from `/admin/skills`, matching
the experience of Themes / Shows / Personas. Authoring is **prompt-only**:
frontmatter + the markdown brief. The executable `tool.mjs` data-fetcher stays a
power-user, disk-drop feature (an operator drops `tool.mjs` next to the
UI-created `SKILL.md` and hits Rescan).

### Non-goals (YAGNI for v1)

- **No `tool.mjs` code editor.** No arbitrary JS authored over an HTTP form.
- **No deleting / folder-removing built-in skills.** Built-ins keep their existing
  edit-in-place behaviour and cannot be deleted (the 7 kinds are always present).
- **No "AI-draft a skill" generator.** Themes/Shows/Personas each have a
  `/generate/*` LLM helper; a `/generate/skill` companion is a plausible
  *follow-up* but is out of scope here. Noted so it isn't silently dropped.

## Background — how skills differ from shows/personas

Themes, Shows, and Personas live in `state/settings.json` and are mutated through
`settings.update()`. **Skills are file-based**: each lives at
`state/skills/<slug>/SKILL.md` (YAML frontmatter + a markdown body that *is* the
DJ's brief), optionally beside a `tool.mjs`. The loader
(`controller/src/skills/loader.ts`) scans that dir and merges results into the
segment-director capability table.

What already exists and is reused unchanged:

- **The file writer** — `writeBuiltinSkillFile()` in `skills/scaffold.ts` renders
  frontmatter + brief to `SKILL.md`. (Renamed/generalised below.)
- **The parser** — `parseFrontmatter()` in `skills/loader.ts`.
- **The loader/reload** — `loadCustomSkills()`; already wired to the Rescan button.
- **The catalogue** — `skillCatalog()` in `skills/_agent.ts`; backs the list and
  already surfaces `custom`, `requiresKey`, `keyUrl`, `cooldownMs`, etc.
- **The validation vocabulary** — `dj.CONTEXT_FIELDS`
  (`['date','clock','time','weather','festival','show','listeners']`), the slug
  regex `SLUG_RE` and the `RESERVED_KINDS` set in `loader.ts`.

So this feature is mostly **new routes + a UI form**, not new machinery.

## Architecture

Three layers, each with one job:

1. **Controller routes** (`controller/src/routes/dj.ts`) — the CRUD surface and the
   single point of validation. The controller is the source of truth; the browser
   does only light UX validation.
2. **File writer** (`controller/src/skills/scaffold.ts`) — generalised to render
   the two extra prompt-only frontmatter keys custom skills use (`window`,
   `requiresKey`).
3. **Admin UI** (`web/components/admin/SkillsPanel.tsx` + a new
   `web/components/admin/skills/SkillForm.tsx`) — a "New skill" button and a
   reusable create/edit form; Edit + Delete buttons on custom skill cards.

### Data flow

```
[New skill] / [Edit] (custom)        SkillForm (web)
        │  POST /dj/skills            ──► validate ──► writeSkillFile() ──► SKILL.md
        │  PUT  /dj/skills/:slug/file ──► validate ──► writeSkillFile() ──► SKILL.md
        │  GET  /dj/skills/:slug/file ◄── parseFrontmatter() (prefill edit form)
        │  DELETE /dj/skills/:slug    ──► rm -rf state/skills/<slug>/
        ▼
  loadCustomSkills()  ──►  skillCatalog()  ──►  { skills:[…] } back to the panel
```

Every mutating route ends by calling `loadCustomSkills()` then returning
`{ skills: skillCatalog() }`, exactly like the existing toggle/edit/rescan routes,
so the panel refreshes from one response shape.

## Controller changes

### 1. `skills/scaffold.ts` — generalise the writer

Rename `writeBuiltinSkillFile` → **`writeSkillFile`** (clearer; it now writes
custom skills too) and extend `SkillFileFields` with two optional prompt-only keys:

```ts
interface SkillFileFields {
  kind: string;             // == slug for custom skills
  label?: string;
  cooldown?: string;
  contextFields?: string[];
  window?: 'any' | 'commute';   // NEW — emitted only when 'commute'
  requiresKey?: string;         // NEW — emitted when set
  feed?: string;                // news built-in only
  feedMaxItems?: number;        // news built-in only
  brief?: string;
}
```

Emit `window:` only when `=== 'commute'` (the loader treats absent/any identically,
so we don't write noise), and `requiresKey:` when non-empty. Update the two
existing call sites (the scaffold loop in the same file; the PUT route in `dj.ts`).
`msToCooldownStr` is unchanged.

### 2. `skills/loader.ts` — widen the export surface

Export `SLUG_RE` and `RESERVED_KINDS` (currently module-private) so the routes
validate against the *same* constants the loader enforces — no drift. `BUILTIN_KINDS`
is already exported.

### 3. `routes/dj.ts` — the CRUD routes

A small shared helper keeps every route honest:

```ts
const SKILLS_DIR = resolve(STATE_DIR, 'skills');
// state/skills/<slug> — slug must pass SLUG_RE (already anchored, no '/' or '.'),
// and the resolved path must stay directly under SKILLS_DIR (defence in depth).
function customSkillDir(slug: string): string { … }   // throws on invalid/traversal
```

**`POST /dj/skills`** — create a custom skill. Body:
`{ name, label?, cooldown?, context?: string[], window?, requiresKey?, brief }`.
Validation (all 400 on failure, with a specific message):

- `name` matches `SLUG_RE`; **not** in `RESERVED_KINDS` (can't shadow a built-in
  kind or a queue-internal kind like `link`/`station-id`).
- The folder must **not already exist** → `409` "a skill named <slug> already exists".
- `brief` required, non-empty.
- `cooldown` (optional) matches `/^\d+\s*[smhd]?$/` (reuse the PUT route's check).
- `context` (optional array): every token in `dj.CONTEXT_FIELDS`, else 400 listing
  the bad tokens + the valid set (mirror the PUT route's logic exactly).
- `window` (optional): `'any'` | `'commute'`, default `'any'`.
- `requiresKey` (optional): matches `/^[A-Z][A-Z0-9_]*$/` (an env-var name), else 400.

On success: `writeSkillFile({ kind: name, … })` → `loadCustomSkills()` →
`queue.log('scheduler', …)` → `res.json({ skills: skillCatalog() })`.
**Created skills arrive disabled** (that's the loader's existing posture — a custom
skill never auto-airs until the operator enables it), so no enable side-effect here.

**`GET /dj/skills/:slug/file`** — broaden the *existing* built-in-only reader to
also serve custom skills, so the Edit form can prefill from disk. Branch on
`BUILTIN_KINDS.has(slug)`:

- built-in → unchanged response (adds `custom: false`).
- custom (folder exists on disk) → parse `SKILL.md`; return
  `{ slug, custom: true, label, cooldown, context, knownContextFields,
     window, requiresKey, hasTool, brief }`, where `hasTool` is
  `existsSync(state/skills/<slug>/tool.mjs)` (read-only flag so the form can warn
  "a data tool is attached and is not edited here").
- neither → 404.

**`PUT /dj/skills/:slug/file`** — broaden the existing built-in editor to also edit
custom skills. Branch on `BUILTIN_KINDS.has(slug)`:

- built-in → the existing path (writeSkillFile with news feed handling), unchanged.
- custom (folder exists) → validate `{ label, cooldown, context, window,
  requiresKey, brief }` with the **same** rules as POST (minus the slug — the slug
  is the immutable identity and comes from the URL). `writeSkillFile` rewrites only
  `SKILL.md`; an existing `tool.mjs` is left untouched. Then reload + return catalogue.
- neither → 404.

**`DELETE /dj/skills/:slug`** — remove a custom skill. Refuse `BUILTIN_KINDS`
(400 "built-in skills can't be deleted"); 404 if the folder doesn't exist; else
`rm(customSkillDir(slug), { recursive: true, force: true })` (removes `SKILL.md`
**and** any `tool.mjs`). Reload, log, return catalogue. The skill's
`settings.skills.enabled[slug]` flag, if any, is left as an inert stale key (it
references a kind that no longer loads, so it's never consulted) — not worth a
settings write.

New imports in `dj.ts`: `mkdir`/`rm`/`stat`/`existsSync` as needed (`readFile`,
`join`, `resolve`, `STATE_DIR` already imported), plus `SLUG_RE`, `RESERVED_KINDS`
from `loader.js` and `writeSkillFile` from `scaffold.js`.

## Web changes

### `web/components/admin/skills/SkillForm.tsx` (new)

A focused, reusable form for **custom create + custom edit** (built-ins keep their
existing inline editor untouched — it has news-specific fields and is working).

Props: `{ mode: 'create' | 'edit', initial?, onSaved(skills), onCancel }`.
Fields:

- **Name (slug)** — text, lowercase-slug; **create-only** (disabled & shown as
  read-only identity in edit mode). Inline hint mirrors `SLUG_RE`.
- **Label** — text (defaults to title-cased slug if blank).
- **Cooldown** — text (`45m` / `6h` / `2d` / bare minutes), same hint as built-in form.
- **Context this segment may mention** — the same tick-box group the built-in form
  uses, via the shared helpers extracted to `web/components/admin/skills/contextFields.ts`
  (`CONTEXT_FIELD_LABELS`, `splitContext`, `CONTEXT_FIELDS_FALLBACK`).
- **Window** — radio: *Any time* (default) / *Commute hours only* (maps to the
  loader's existing `window: commute`, the same gate the built-in traffic skill uses).
- **Brief** — textarea (the DJ's instructions); required.

`requiresKey` is **not** a visible field. It only gates a skill inert until an env
var is set, which is only meaningful when the skill has a hand-dropped `tool.mjs`
that calls a keyed API — and tool.mjs authoring is out of scope here. The form
keeps it as a hidden passthrough (empty on create, loaded-as-is on edit) so editing
a disk-authored skill never silently strips its key-gate.
- When `hasTool` (edit mode): a small read-only note "A `tool.mjs` data tool is
  attached. Edit or remove it on disk + Rescan."

Submit → `POST /dj/skills` (create) or `PUT /dj/skills/:slug/file` (edit); on
success calls `onSaved(j.skills)`. Shared context-field helpers move out of
`SkillsPanel` into `skills/contextFields.ts`; both the built-in editor (in
`SkillsPanel`) and `SkillForm` import them, so the vocabulary is defined once.

### `web/components/admin/SkillsPanel.tsx`

- **Hero bar:** add a **New skill** button beside *Rescan*. Toggling it renders
  `SkillForm` (create mode) as a card at the top of the list.
- **Custom skill cards:** today they only have *Run now* + the toggle (the panel
  explicitly hides Edit for `s.custom`). Add **Edit** (expands `SkillForm` in edit
  mode inline under the card, prefilled from `GET /dj/skills/:slug/file`) and
  **Delete** (confirm dialog → `DELETE /dj/skills/:slug`). Built-in cards are
  unchanged (their existing inline editor stays).
- On any create/edit/delete success, replace `skills` state from the returned
  `{ skills }` array (same pattern as toggle/rescan).
- Update the hero copy: "Drop your own skills into `state/skills/…` and Rescan"
  becomes "Click **New skill** to author one here, or drop a folder into
  `state/skills/<name>/` (with an optional `tool.mjs` data tool) and Rescan."

## Error handling

- Controller validates everything and returns `4xx` + `{ error }`; the form surfaces
  it via the existing `notify.err` / `errorMessage` helpers (same as the rest of the
  panel).
- Duplicate slug → `409`; the form maps it to a friendly "that name is taken".
- Path-traversal / bad slug can't reach the filesystem: `SLUG_RE` is anchored and
  rejects `/`, `.`, and uppercase, and `customSkillDir()` re-asserts the path stays
  under `SKILLS_DIR`.
- Reload after a write is best-effort logged (loader never throws); a write that
  succeeds but reload-warns still returns the (now-current) catalogue.

## Testing & verification

No unit-test runner in this repo; the merge gate is `npm run lint`
(`eslint . && tsc --noEmit`) in **both** `controller/` and `web/`. Plan:

1. `npm run lint` in `controller/` and `web/` — must pass (the CI gate).
2. Manual smoke in the dev stack (`docker-compose.dev.yml` + `web` dev server):
   - Create a prompt-only skill → appears in the list, **disabled**, with a
     `state/skills/<slug>/SKILL.md` on disk whose frontmatter round-trips.
   - Edit it (change brief, cooldown, window, context) → file rewrites,
     catalogue reflects it.
   - Drop a `tool.mjs` beside it on disk + Rescan → `hasTool` note shows on Edit;
     editing the brief leaves `tool.mjs` intact.
   - Delete it → folder gone, removed from the list.
   - Reject paths: reserved name (`news`), bad slug (`My Skill`), empty brief,
     bad context token, duplicate name → each returns a clear error in the UI.
   - Built-in edit (e.g. News feed) still works unchanged (regression check).

## Docs

- `docs/custom-skills.md` — note that prompt-only skills can now be created /
  edited / deleted from **/admin/skills**, and that `tool.mjs` remains a disk-drop
  (+ Rescan) addition.
- `web/content/manual/skills.*` (the `/manual/skills` page) — same note, if present.
- `SkillsPanel` hero copy (above).

## Files touched

- `controller/src/skills/scaffold.ts` — rename→`writeSkillFile`, add `window`/`requiresKey`.
- `controller/src/skills/loader.ts` — export `SLUG_RE`, `RESERVED_KINDS`.
- `controller/src/routes/dj.ts` — POST create, DELETE, broaden GET/PUT `…/file` to custom.
- `web/components/admin/skills/SkillForm.tsx` — new reusable create/edit form.
- `web/components/admin/skills/contextFields.ts` — new (shared context-field helpers, imported by both `SkillsPanel` and `SkillForm`).
- `web/components/admin/SkillsPanel.tsx` — New-skill button, custom Edit/Delete, copy.
- `docs/custom-skills.md`, `web/content/manual/skills.*` — doc notes.
