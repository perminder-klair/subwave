# Community personas — design

**Date:** 2026-07-05
**Status:** approved-by-pattern (mirrors the shipped community-skills pipeline end to end)

## What

Let operators share DJ personas with the community the same way they share
skills: a shipped read-only catalog browsable on a public page and in the
admin console, one-tap install into the station's roster, and a no-fork
GitHub Issue Form that a workflow turns into a one-file PR.

## Why

Skills sharing (#851/#849) proved the loop: contribute via issue form →
bot PR → maintainer merge → ships in the image → installable everywhere.
Personas are the other half of a station's character and are just as
portable — a persona is a name, a tagline, a soul (character prose), and a
few behaviour knobs. Voice/avatar are station-specific and stay local.

## Approaches considered

1. **Mirror the skills pipeline file-for-file** (chosen) — markdown catalog
   dirs shipped in the controller image, list/read module, public browse
   route, admin install route, issue form + submission workflow, public
   showcase page. Maintainers and contributors already know this shape.
2. JSON catalog file — fewer files but breaks the one-dir-per-entry PR
   ergonomics (merge conflicts, no per-entry provenance) the skills flow
   relies on.
3. Registry service / external repo — over-engineered for a catalog that
   ships with the image and updates on release.

## Portable persona fields

From `validatePersonasStrict` (settings.ts): `name` (≤40, the DJ's on-air
name), `tagline` (≤80), `soul` (1–1000, the character prose — the file
body), `frequency` (quiet|moderate|aggressive), `scriptLength`
(concise|extended), `djMode` (bool), tone dials `humour`/`localColour`/
`warmth` (0–10, 5 = neutral), `language` (≤60, free text).

NOT portable: `id` (minted on install), `avatar` (binary, station-local),
`tts` (engines/voices/keys are station-specific — install uses the piper
defaults), `skills` (installed set differs per station — install uses
`null` = "all skills", the roster default).

## Components

### 1. Catalog store — `controller/src/personas/community/<slug>/PERSONA.md`

Mirrors `skills/community/<slug>/SKILL.md`. Flat frontmatter parsed by the
existing `parseFrontmatter` (skills/loader.ts):

```markdown
---
name: <slug>              # must equal the folder name (like skills)
displayName: Marlowe      # the DJ's on-air name; falls back to title-cased slug
tagline: …                # ≤80
frequency: moderate       # quiet|moderate|aggressive (default moderate)
scriptLength: concise     # concise|extended (default concise)
djMode: true              # optional, default false
humour: 7                 # optional 0–10, default 5
localColour: 5
warmth: 8
language: …               # optional, ≤60
submittedBy: <gh-login>   # provenance, stamped by the workflow
dateAdded: YYYY-MM-DD
dateModified: YYYY-MM-DD
---
<soul — the character prose, 1–1000 chars>
```

New module `controller/src/personas/community.ts`: `CommunityPersona`
interface, `listCommunityPersonas()`, `readCommunityPersona(slug)` —
defensive like the skills versions (missing dir → `[]`, broken entry →
skipped, slug must match `SLUG_RE` from skills/loader). Two seed entries
ship so the page/modal isn't empty.

### 2. Controller routes

- **`GET /personas/community`** (routes/public.ts, no gate) — `{ community: [...] }`.
  Static shipped catalog, same posture as `GET /skills/community`. The admin
  panel reuses this same route and computes `installed` client-side by
  case-insensitive name match against the roster it already holds (unlike
  skills, install state lives in settings the panel has loaded — no
  annotated admin route needed).
- **`POST /personas/community/:slug/install`** (routes/personas.ts,
  requireAdmin) — 404 unknown slug, 409 when the roster already has a
  persona with the same name (case-insensitive) or is at `PERSONA_LIMIT`.
  Builds a complete persona (minted `p_` id, default piper tts block,
  `skills: null`, `avatar: ''`) and appends via `settings.update()`.
  Does NOT touch `activePersonaId` — the persona arrives in the roster but
  not on air, the analogue of a skill arriving disabled. Returns
  `{ personas, persona }`. `PERSONA_LIMIT` gets exported from settings.ts.

### 3. Admin UI

- **PersonasPanel**: a `Community` button in the hero (mirrors SkillsPanel),
  opening a modal that lists the catalog with brief/tagline/provenance and
  an Install button per entry (`installed` pill when the name is already in
  the roster). Install appends the returned persona to the local form state
  so unsaved edits survive.
- **PersonaEditor**: a `Share to community` footer button — opens the
  prefilled `add-persona.yml` Issue Form in a new tab via a new
  `personaSubmitUrl()` in web/lib/repo.ts (mirrors `skillSubmitUrl`).

### 4. Public showcase — `/personas`

Mirrors `/skills`: `web/app/personas/{layout,page}.tsx` (force-dynamic,
fetches via `CONTROLLER_INTERNAL_URL`), `web/lib/communityPersonas.ts`,
`web/components/personas/CommunityPersonaCard.tsx` (reuses the `bs-skill-*`
broadsheet card classes; shows name, tagline, soul, behaviour tags,
@submitter credit). Footer gains a fourth Back Page (§§ 01–04, grid goes
2-col on sm / 4-col on lg). Sitemap gains `/personas` (and `/skills` if
missing).

### 5. Submission flow — GitHub

- `.github/ISSUE_TEMPLATE/add-persona.yml` — slug, display name, tagline,
  soul (textarea), frequency/scriptLength/djMode dropdowns, dials, language,
  reviewer summary, contribution-terms checkboxes. Mirrors add-skill.yml.
- `.github/workflows/persona-submission.yml` — mirrors
  skill-submission.yml: parses the issue body inside actions/github-script
  (untrusted input never touches a shell), validates (SLUG_RE, soul 1–1000,
  enums, dials 0–10, lengths), writes
  `controller/src/personas/community/<slug>/PERSONA.md` on a
  `persona/<slug>` branch off develop, opens/updates the PR, comments back.
  Requires a `persona-submission` repo label (same caveat as
  `skill-submission` — created once by the maintainer).

## Error handling

Same postures as skills: catalog reads never throw (skip broken entries),
public route 500s only on unexpected errors, install route maps
known failures to 400/404/409, workflow comments validation problems back
onto the issue with a `needs-info` label.

## Testing

No test runner in this repo — `npm run lint` (eslint + tsc) in both
`controller/` and `web/` is the merge gate. Manual verification: run the
dev stack from the worktree, hit `GET /personas/community`, install a seed
via the admin panel, render `/personas`.
