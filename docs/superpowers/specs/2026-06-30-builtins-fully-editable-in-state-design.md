# Built-ins become fully-editable skills in state/ — one load root

**Date:** 2026-06-30
**Depends on / stacks atop:** the `unified-skills-architecture` branch (built-ins are
already directories with `SKILL.md` + `tool.mjs` and a shared `services` facade). This
finishes that arc: built-in `tool.mjs` becomes operator-editable, and `state/skills`
becomes the single runtime load root.

## Problem

The unified-skills work made built-in and custom skills *load* through the same code,
but they still live in two different places with two different trust postures:

- A built-in's **`SKILL.md` brief** is scaffolded to `state/skills/<kind>/` and is
  operator-editable; the loader merges it back as an *override*.
- A built-in's **`tool.mjs`** stays in the read-only app dir
  (`controller/src/skills/builtins/<kind>/`) and is **never** copied out. The operator
  can edit the words a built-in speaks, but not its data-fetch code.

So a built-in is still a second-class citizen relative to a custom skill: you can fork
a custom skill's `tool.mjs` freely, but to change how `weather` or `web-search`
*fetches*, you'd have to fork core. The override-merge machinery
(`builtinBase` + `builtinOverrides` + `builtinCapabilities()`) exists only to keep
those two worlds reconciled.

## Goal

**Every skill — shipped or operator-added — is a self-contained directory in
`state/skills/<slug>/` (`SKILL.md` + optional `tool.mjs`), loaded by one code path with
one trust posture.** The seven built-ins are *seeded* there on first boot from
read-only templates that ship in the image; after seeding they are ordinary editable
skills. The app-dir `builtins/` folder stops being a runtime load root and becomes a
**seed / reset template store**.

### Non-goals

- No change to *what* the skills do or say on air. Pure mechanism + storage change.
- No in-browser code editor for `tool.mjs`. Editing a built-in's code is the same
  power-user flow custom skills already have: edit the file in `state/skills/<kind>/`
  on disk, then **Rescan**. The win is that the file now *lives* in state and is the
  one that runs — not that we add a UI for it.
- No new skill features, context fields, or scheduling changes.

## Decisions taken (brainstorm)

1. **Eager copy / full unify.** On first boot, seed `SKILL.md` **and** `tool.mjs` for
   all seven built-ins into `state/skills/<kind>/`. `state/skills` is then the single
   runtime load root. The override-merge machinery is deleted.
2. **Delete posture: disable-only.** A seeded built-in can be toggled off but not
   hard-deleted; the folder is re-seeded on boot if missing. The station's core skill
   set stays stable (a fresh or wiped install always has weather/news/…). Matches
   today's "built-ins can't be deleted" guard.
3. **Fencing: fence everything.** Every tool loaded from `state/` runs behind the 8s
   timeout + try/catch, seeded or not. One code path. The network-heavy seeded tools
   (`web-search`, `news` RSS, `curiosity`'s on-this-day) must complete within 8s or
   degrade to "no data" that tick — acceptable, since segments are optional and the
   listener-facing outcome is silence either way.
4. **Reset-to-default restores both files.** The admin "Reset to default" re-copies
   `SKILL.md` **and** `tool.mjs` from the current image's shipped template. This is both
   the recovery path for a broken edit and the way to pull in a shipped `tool.mjs`
   bug-fix after first boot — the accepted mitigation for "updates don't propagate."

### Accepted tradeoff

Once a built-in's `tool.mjs` is seeded into `state/` it is never auto-overwritten, so a
later image that ships an improved `weather/tool.mjs` will **not** reach an install that
already seeded it. The operator pulls the new version deliberately via **Reset to
default** (decision 4). This is the explicit cost of "operators fully own their
built-ins," chosen over version-tracking complexity.

## Target architecture

### 1. One runtime load root

`state/skills/<slug>/` is the only directory scanned to build the live capability set.
Every folder there — `weather`, `news`, the operator's `bhangra-tip` — loads through the
**same** `loadSkillDir()` call and yields a cap with the **same** shape and the **same**
fenced trust posture. There is no longer a "built-in cap" vs "custom cap" at load time.

### 2. The app-dir `builtins/` becomes a template store

`controller/src/skills/builtins/<kind>/{SKILL.md,tool.mjs}` stays in the image (prod
`COPY`, dev bind-mount) but is **no longer loaded at runtime**. It is read only by the
seeder and the reset route. Two cheap helpers replace `loadBuiltins()`:

- `seededKinds(): Set<string>` — `readdir` of the templates dir → the set of shipped
  kinds. Computed once at boot. Drives the residual first-party affordances below.
- `readTemplate(kind): { skillMd: string, hasTool: boolean, toolPath: string, data, body }`
  — read a template's files on demand (for seeding, reset, and the admin "defaults"
  payload). No resident template caps are kept in memory.

### 3. `seeded` replaces the overloaded `custom` flag

Today `cap.custom` conflates two orthogonal axes: *is the tool operator code?* (drives
fencing) and *is this a shipped kind?* (drives enabled-by-default, the UI badge, the
delete/edit/reset routes). After this change fencing is unconditional, so the fencing
axis collapses and only the provenance axis remains. Rename it for honesty:

- New cap field **`cap.seeded: boolean`** = `seededKinds().has(slug)`.
- Downstream logic flips from `cap.custom` to `!cap.seeded`, unchanged in behaviour:
  - **Enabled-by-default** (`availableCapabilities`, `skillCatalog`):
    `cap.seeded ? enabled[slug] !== false : enabled[slug] === true`. Seeded built-ins
    default on; operator skills are discovered-but-disabled.
  - **Reserved names** (`RESERVED_KINDS`): queue-internal kinds + `seededKinds()`. A
    custom skill still can't be named `weather` (the folder-exists 409 also catches it,
    but the reserved check gives the clearer error).
- The **`skillCatalog()` API field stays `custom: !cap.seeded`** so the web admin needs
  no change to how it badges operator skills / explains off-by-default. (Its meaning —
  "operator-authored, not shipped" — is exactly `!seeded`.)

### 4. Fencing is unconditional

`buildSegmentTools()` drops the `const fenced = !!cap.custom` branch and always wraps
the tool call in `withTimeout(p, 8000)`. Every skill tool, seeded or operator, gets the
same 8s ceiling. (Timeout stays 8s for consistency with today's custom fence; the
network-heavy seeded tools are verified against it in smoke testing — see Testing.)

### 5. Scaffolder → seeder: seed both files, idempotent, re-seed if missing

`scaffoldBuiltinSkills()` becomes `seedBuiltinSkills()`. For each `seededKinds()` kind:

- Ensure `state/skills/<kind>/SKILL.md` exists; if missing, copy it from the template.
  News' `feed:` line is seeded from `NEWS_FEED_URL` (env) or the template's BBC default,
  preserving the 12-factor story on a fresh install (file wins after first boot).
- Ensure `state/skills/<kind>/tool.mjs` exists **iff the template has one**; if missing,
  copy the template's `tool.mjs` verbatim.
- **Idempotent**: an existing file is never clobbered, so operator edits survive a
  restart. A *missing* file is restored — which is also how decision 2's "re-seed on
  boot if the folder was deleted" is implemented (delete the folder on disk → next boot
  restores both files).
- Best-effort: a failure is logged, never fatal to boot.

Seeding copies the template `SKILL.md` **verbatim** (then patches news' feed line),
rather than re-rendering it from parsed fields — so `state/` mirrors the shipped file
exactly. This replaces today's `writeSkillFile`-from-cap-fields seeding; `writeSkillFile`
stays for the admin edit/create routes (which assemble a file from form fields).

### 6. Reset-to-default = server-side reseed of both files

Today "Reset to default" is a *client-side form repopulate*: it fills the edit form from
the `defaults` payload and the operator saves, rewriting `SKILL.md` only. A code file
can't be restored that way. Add a server route:

- **`POST /dj/skills/:kind/reset`** (admin) — for a seeded kind, force-copy the
  template's `SKILL.md` **and** `tool.mjs` over `state/skills/<kind>/` (overwriting),
  reload, return the refreshed catalogue. 400 for a non-seeded slug (custom skills have
  no shipped default).

The admin "Reset to default" button calls this route instead of (or before) the form
repopulate, then refetches the edit form. The `defaults` payload in
`GET /dj/skills/:kind/file` stays for prefill and is sourced from `readTemplate(kind)`.

### 7. Delete guard stays, keyed on `seeded`

`DELETE /dj/skills/:slug` keeps rejecting seeded kinds ("built-in skills can't be
deleted — disable them instead"), now checked against `seededKinds()`. Custom skills
delete their whole folder as today. (Even a manual on-disk `rm` of a seeded folder is
undone by the next boot's seeder — decision 2.)

## What gets deleted / shrinks

- `builtinBase`, `builtinOverrides`, `builtinCapabilities()`, `getBuiltinOverrides()`,
  `builtinBaseCaps()`, `loadBuiltins()` — the entire override-merge layer in
  `loader.ts`.
- The built-in-kind **override special-case** in `loadCustomSkills()` (the branch that
  parses a `state/skills/<built-in>/SKILL.md` as a brief-only override and skips its
  `tool.mjs`). A seeded folder is now just loaded as a full skill.
- `allCapabilities()` in `_agent.ts` collapses from `[...builtinCapabilities(),
  ...customCapabilities()]` to the single loaded set.
- The `fenced = !!cap.custom` branch in `segment-tools.ts`.

## Migration & backward compatibility

- **Existing install with built-in brief overrides** (`state/skills/weather/SKILL.md`,
  no `tool.mjs`): on the upgrade boot the seeder sees `SKILL.md` present (keeps the
  operator's brief) and `tool.mjs` missing (copies the template's in). Weather now has
  both files; it loads as a full skill with the operator's brief preserved. The outcome
  matches today's override merge, without the merge.
- **Existing custom skills** (`(ctx, state[, services, config]) => …`): unaffected —
  same folder, same loader, same fence.
- **Enabled toggles** (`settings.skills.enabled`, keyed by kind slug): unchanged — slugs
  are stable (`weather` stays `weather`), so existing on/off state carries over.
- **A wiped `state/`**: the seeder recreates all seven from templates on next boot, enabled
  by default — same as a fresh install.

## Security posture

Unchanged from the unified-skills baseline, and slightly *more* consistent: every skill
tool now runs behind the 8s fence + try/catch (previously seeded tools ran unfenced).
`services` is still the only way a tool reaches the world — a curated, read-mostly facade
(search, library reads, play-log reads, feeds, durable recall, namespaced log) with no
write/settings/secret surface. Seeding operator-editable copies of the built-in tools
does not widen what a tool *can* do; it only moves where the file lives. It remains the
operator's own controller and own keys (same trust model as a locally-installed Claude
Code skill).

## Files touched (anticipated)

- **`controller/src/skills/loader.ts`** — drop `loadBuiltins`/`builtinBase`/override
  machinery; add `seededKinds()` + `readTemplate()`; one uniform `state/skills` scan
  setting `cap.seeded`; export `SEEDED_KINDS` (replacing `BUILTIN_KINDS`); `RESERVED_KINDS`
  = internal + seeded.
- **`controller/src/skills/scaffold.ts`** — `scaffoldBuiltinSkills` → `seedBuiltinSkills`
  (copy both files from templates, idempotent, verbatim SKILL.md + news feed patch).
  Keep `writeSkillFile`/`msToCooldownStr` for the admin routes.
- **`controller/src/skills/_agent.ts`** — `allCapabilities()` = loaded set;
  `cap.custom` → `!cap.seeded` at the enabled-by-default and catalogue spots.
- **`controller/src/llm/internal/tools/segment-tools.ts`** — always fence.
- **`controller/src/routes/dj.ts`** — `BUILTIN_KINDS` → `SEEDED_KINDS`; `defaults` payload
  via `readTemplate`; new `POST /dj/skills/:kind/reset`; delete guard keyed on seeded.
- **`controller/src/server.ts`** — `scaffoldBuiltinSkills()` call → `seedBuiltinSkills()`
  (verify it still runs before `loadAllSkills()` so seeded files exist when the scan runs).
- **`controller/src/broadcast/queue.ts`** — verify `registerSkillKinds()` still fed from
  the single loaded set (no built-in/custom split to reconcile).
- **`web/components/admin/skills/SkillEditModal.tsx`** — wire "Reset to default" to the
  new reset route (restores tool.mjs too); minor copy tweak so a built-in's editor notes
  its `tool.mjs` now lives in `state/` and is edited on disk + Rescan, like a custom skill.
- **Docs:** `docs/custom-skills.md` — built-ins are now seeded into `state/`; the
  app-dir is a template/reset source; Reset-to-default restores shipped code.

## Testing & verification

No unit runner; the merge gate is `npm run lint` (eslint + `tsc --noEmit`) in `controller/`
+ `web/`. Plan:

1. Lint green in both packages.
2. **Fresh-install seed**: empty `state/` → boot → all seven `state/skills/<kind>/` exist
   with both `SKILL.md` and `tool.mjs`; all appear enabled in `/dj/skills`; each **Run now**
   still fires (weather speaks, news pulls the feed, curiosity hits on-this-day,
   web-search/now-playing-dig search) — proving the seeded tools run within the 8s fence.
3. **Upgrade migration**: pre-seed `state/skills/weather/SKILL.md` with an edited brief and
   no `tool.mjs` → boot → brief preserved, `tool.mjs` copied in, weather airs the edited
   brief. Proves the override→full-skill migration.
4. **Edit then Reset**: break `state/skills/weather/tool.mjs` (e.g. `throw`) → weather
   degrades to no-data (fenced) → "Reset to default" → both files restored from template →
   weather airs again. Proves decision 4 end to end.
5. **Delete is disable-only**: DELETE a seeded kind → 400; `rm -rf` the folder on disk →
   next boot re-seeds it. Proves decision 2.
6. **Custom backward-compat**: the operator's existing 2-arg `bhangra-tip` still loads,
   stays disabled until enabled, and runs.

## Suggested implementation order (one PR, staged commits)

1. **Seeder + templates.** `seededKinds()`/`readTemplate()`; `seedBuiltinSkills()` copies
   both files idempotently; server calls it before the skill scan. (No load-path change
   yet — overrides still merge; this just also drops `tool.mjs` into state.)
2. **Single load root.** Remove the override machinery; load every `state/skills` folder
   as a full skill with `cap.seeded`; delete the override special-case; `allCapabilities()`
   collapses. Migration path (existing overrides) verified here.
3. **Unconditional fence** + `custom`→`seeded` rename through `_agent.ts`/`segment-tools.ts`,
   `BUILTIN_KINDS`→`SEEDED_KINDS` through `dj.ts`/`loader.ts`.
4. **Reset route + web wiring** (`POST /dj/skills/:kind/reset`, SkillEditModal button).
5. **Docs.**
