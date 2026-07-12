# Skill organization: tags, filter/sort, and assign-from-skill

**Date:** 2026-07-12
**Status:** Implemented
**Origin:** Discord community request — libraries past ~15–20 skills with 8+ personas make the who-has-what matrix unwieldy. Three asks: (1) filter/sort, especially "filter by which DJ/Show has it enabled", (2) freeform tags, (3) assign a skill to DJs from the skill itself instead of DJ-by-DJ.

## Problem

The admin Skills page (`web/components/admin/SkillsPanel.tsx`) renders skill cards in raw `readdir` order with no search, sort, or filter. Skill→DJ assignment lives only on the persona side (`personas[i].skills`, edited via `PersonaSkillsCard` one DJ at a time), so answering "which DJs run the news skill?" means opening every persona. There is no tagging or grouping concept anywhere in the stack.

## Current model (facts the design builds on)

- A skill is `state/skills/<slug>/SKILL.md` (flat `key: value` frontmatter parsed by `parseFrontmatter` in `controller/src/skills/loader.ts`) + optional `tool.mjs`. Unknown frontmatter keys are already retained verbatim in `cap.config`.
- `skillCatalog()` (`controller/src/skills/_agent.ts`) is the single API/UI projection, served by `GET /dj/skills`.
- Assignment = `personas[i].skills : string[] | null`. `null` (default) means **all skills**; `[]` means none; capped at `SKILLS_PER_PERSONA_LIMIT = 20` (`controller/src/settings.ts`). Runtime gate: `availableCapabilities()` skips a capability when `persona?.skills && !persona.skills.includes(cap.skill)`.
- Shows do not hold skill lists. A show's skill eligibility keys off its **host persona**; `shows[i].segmentSkill` only pins the programme feature beat.
- Skills travel: export `.zip`, import, and community install all round-trip `SKILL.md` — so anything stored in frontmatter travels with the skill.

## Goals

1. Freeform tags on skills, editable in the skill editor, that survive export/import/community sharing.
2. Search, sort, and filter on the Skills page — including "enabled for DJ X" and (via the host mapping) "enabled for show Y".
3. Assign/unassign a skill to any set of personas from the skill's own editor, in one place.

## Non-goals

- No managed/central category taxonomy (tags stay freeform and skill-owned).
- No per-show skill lists — shows keep deriving eligibility from the host persona (changing that is a much bigger behaviour change).
- No changes to runtime gating semantics (`availableCapabilities`, cooldowns, frequency, budget).
- No native-app changes; admin web only.

## Approaches considered

**A. File-backed tags + client-side organization + a server-side assignment endpoint (chosen).**
Tags live in `SKILL.md` frontmatter so they ride export/import/community for free and stay consistent with everything else about a skill. Filter/sort is pure client-side over data the admin page already has access to. Reverse assignment gets one new controller endpoint that does the read-modify-write on `personas[].skills` server-side, so the null-sentinel logic lives in exactly one place.

**B. Client-only minimal.** Ship search/sort/persona-filter using existing `GET /dj/skills` + `GET /settings`; no tags, no assignment endpoint. Fast, but delivers only one of the three asks and the null-sentinel join logic ends up in the UI anyway.

**C. Settings-backed taxonomy.** A `settings.skillTags` registry with managed categories and skill→category mapping in `settings.json`. Rejected: second source of truth beside `SKILL.md`, tags would not travel with skill export/community sharing, and it adds admin surface (category CRUD) nobody asked for.

## Design (Approach A)

### 1. Tags — data model

New frontmatter key on `SKILL.md`:

```yaml
tags: late-night, factual, chatty
```

- **Parsing** (`loader.ts`): new `parseTags(raw)` — split on commas, trim, lowercase, validate each against `TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/` (invalid entries dropped, not fatal), dedupe, cap at `TAGS_PER_SKILL_LIMIT = 8`. `loadSkillDir` sets `cap.tags: string[]` (default `[]`).
- **Catalog**: `skillCatalog()` adds `tags` to each entry.
- **Write path**: `writeSkillFile` (`scaffold.ts`) renders a `tags:` line when non-empty; `buildCustomSkillFields` (`routes/dj.ts`) accepts `tags` as `string[]` or comma string from both `POST /dj/skills` and `PUT /dj/skills/:kind/file`, normalized with the same `parseTags`.
- **Built-ins**: editing a built-in's `SKILL.md` already works (state copy is the live one), so tags on built-ins need no special casing. Shipped templates get **no** seeded tags — tags are operator vocabulary.
- **Compat**: older controllers ignore an unknown `tags:` key (retained in `config`), so shared/imported skills degrade gracefully in both directions.

### 2. Assign-from-skill — API

New admin endpoint in `controller/src/routes/dj.ts`:

```
PUT /dj/skills/:slug/personas        (requireAdmin)
body:     { personaIds: string[] }   // the personas that should have this skill
returns:  { assignments: Record<personaId, boolean>, personas: [{id, name, hasSkill}] }
errors:   404 unknown skill, 400 bad personaIds
```

Server-side read-modify-write over `settings.personas`:

- **Persona should have the skill** (`id ∈ personaIds`):
  - `skills === null` → no-op (null already means "all skills"). Do **not** materialize.
  - array missing the slug → append.
- **Persona should not have it** (`id ∉ personaIds`):
  - `skills === null` → materialize to the full current catalog slug list **minus** this skill (same thing `PersonaSkillsCard` effectively does the first time an operator unticks something).
  - array containing the slug → remove.
- Persist once via `settings.update({ personas })`; unchanged personas pass through untouched.
- Unknown persona ids in the payload → 400 listing them.

**Limit bump (required by materialization):** `SKILLS_PER_PERSONA_LIMIT` goes from **20 → 64**. Rationale: the whole premise of this feature is libraries past 20 skills; materializing "all minus one" for a 25-skill library would exceed the current cap, and `PersonaSkillsCard` already has this latent bug today (ticking everything on a >20-skill library fails strict validation). 64 matches `SHOWS_LIMIT`. The strict validator error message updates accordingly. No migration needed — existing arrays are all ≤20.

### 3. Skills page — filter, sort, search (client-side)

All in `SkillsPanel.tsx`; no new fetch pattern (stays `adminFetch` + `useEffect`). The panel additionally fetches `GET /settings` once (the admin page is already behind the same Basic-auth gate) and keeps only `personas: [{id, name, skills}]` and `shows: [{id, name, personaId, segmentSkill}]` (`personaId` is the host) from it.

Toolbar above the card list:

- **Search box** — case-insensitive substring over `label`, `name`, and the brief/description.
- **Filter: DJ / show** — one shadcn `Select`. Options: "All", each persona ("DJ: Vex"), each show ("Show: Night Drive"). A skill matches a persona when `persona.skills === null || persona.skills.includes(skill.name)`. A show resolves to its host persona and additionally matches its `segmentSkill` pin (pin shown as a badge on the matching card while a show filter is active).
- **Filter: tag** — chip row of the union of all catalog tags (hidden when no tags exist yet), multi-select, OR semantics; mirrors the show-music-filter chip idiom.
- **Filter: status** — "All / Enabled / Disabled / Needs key / Custom / Built-in" select.
- **Sort** — "A–Z (default) / Enabled first / Cooldown". A–Z becomes the default presentation, fixing today's arbitrary `readdir` order.
- Header gets a filtered-count readout ("12 of 27 skills") and a one-click "Clear filters".

Filter/sort state is component-local (resets on navigation) — no URL params or persistence in v1.

Card additions: tag pills (small, after the cooldown pill) and an assignment pill — "All DJs" when every persona matches (including via `null`), otherwise "3 of 8 DJs".

### 4. Skill editor — tags input + DJs section

In `SkillEditModal.tsx`:

- **Tags** — freeform chip input (type, Enter/comma to add, click to remove), with suggestion chips drawn from tags already used elsewhere in the catalog. Client-validates against the same slug rule/8-cap; saved through the existing `PUT /dj/skills/:kind/file` / `POST /dj/skills` payloads.
- **DJs** — a checklist of all personas (name + checked state), semantics identical to `PersonaSkillsCard` but inverted. Initial checked state: `skills === null || skills.includes(name)`. On save, if the set changed, the modal calls `PUT /dj/skills/:slug/personas` **after** a successful SKILL.md save; the section is hidden in create mode until the skill exists (create → then assign, or default remains "all DJs via null"). A caption repeats the existing rule: the skill must also be enabled station-wide to air.
- `PersonaSkillsCard` stays as-is — the two edit surfaces write the same field and cannot drift because the server owns the merge.

### 5. Error handling

- Assignment endpoint failures surface as a toast; the SKILL.md save is not rolled back (the two saves are independent resources — the modal reports which part failed).
- Invalid tags in hand-edited files are silently dropped at load (consistent with the loader's lenient posture); the editor never produces them.
- `Rescan` keeps working unchanged; tags flow through it like every other frontmatter field.

### 6. Testing / verification

- No test runner in the repo; the merge gate is `npm run lint` in `controller/` and `web/` — both must pass.
- Manual verification with the `verify` skill flow (isolated controller + Playwright against `/admin/skills`): tag a skill, confirm the tag survives a rescan and an export→import round-trip; filter by a persona with a materialized list and one with `null`; assign/unassign from the modal and confirm `PersonaSkillsCard` reflects it; confirm a >20-skill materialization persists after the limit bump.

### Touched files

| Area | File | Change |
|---|---|---|
| Loader | `controller/src/skills/loader.ts` | `parseTags`, `TAG_RE`, `cap.tags` |
| Catalog | `controller/src/skills/_agent.ts` | `tags` in `skillCatalog()` |
| Scaffold | `controller/src/skills/scaffold.ts` | render `tags:` in `writeSkillFile` |
| Routes | `controller/src/routes/dj.ts` | `tags` in create/edit validators; new `PUT /dj/skills/:slug/personas` |
| Settings | `controller/src/settings.ts` | `SKILLS_PER_PERSONA_LIMIT` 20 → 64 |
| Skills page | `web/components/admin/SkillsPanel.tsx` | toolbar (search/filters/sort), card pills, `/settings` fetch |
| Editor | `web/components/admin/skills/SkillEditModal.tsx` | tags chip input, DJs checklist |
| Types | `web/components/admin/personas/types.ts` | `SkillCatalogEntry.tags` |
