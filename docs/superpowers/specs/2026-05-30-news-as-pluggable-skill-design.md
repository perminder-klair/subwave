# News as a pluggable skill

**Status:** design — not yet implemented
**Branch:** `worktree-pluggable-skills`
**Prerequisite:** the pluggable-skills loader (`cb5220d`) is already on this branch. This design builds on it.
**Issue motivating the work:** [#193 — News/RSS feed changes not taking effect](https://github.com/perminder-klair/subwave/issues/193)

---

## Context

Issue #193 reports that an operator changed the news feed URL but the on-air news segments still pulled from BBC. The reproduction is mundane — `NEWS_FEED_URL` is env-only (`controller/src/config.ts:161`), it's not in `settings.json`, not in the admin UI, and not in the onboarding wizard. The operator either edited a file the running container doesn't read (`controller/.env` instead of the root `./.env` that `docker-compose.yml:112` loads as `env_file`), or edited the right file but didn't recreate the container. Either way: the surface is wrong for the kind of change operators want to make.

The obvious fix is "add a multi-feed schema to `state/settings.json` and an admin UI to manage it." That fix was drafted and rejected after looking at this branch.

The pluggable-skills loader already provides every primitive a multi-feed news system would need:

| What a `settings.news.feeds[]` schema would have to invent | What the loader already gives us |
|---|---|
| Per-feed enable toggle | Per-skill toggle in `/admin/skills` |
| Per-feed cooldown | `cooldown:` frontmatter (parsed) |
| Persona allowlist per feed | Persona `skills[]` already binds by slug |
| Fallback when a feed breaks | `requiresKey` / `ready()` → unready skill is not offered; other skills tick |
| Hot-reload after edit | `POST /dj/skills/rescan` |
| "Discovered but off" safety | Enforced by `loadCustomSkills()` |
| Per-skill data fetch with timeout | `tool.mjs` wrapped at 8s in `segment-tools.ts` |

The bespoke schema route would re-invent every row. The one genuinely new concept we considered — *categories* — collapses into "the persona's existing skill allowlist," which already does the same job.

**Direction:** news is not a special-case capability. It becomes the flagship example of the pluggable-skills primitive. The built-in `news` entry in `CAPABILITIES` goes away. Each feed is a skill. Most operators add a feed through a small UI shortcut; power users drop a folder.

### Scope slices (all in)

After scoping in conversation, four slices are in scope for this design — all four collapse out of the primitive:

1. **Multi-feed library + admin UI** — operator manages a named list of feeds without editing `.env`.
2. **Persona binding** — different personas read different subsets of feeds.
3. **Robust fetcher + visibility** — Atom support, real User-Agent, persistent dedup, `<pubDate>` freshness, per-feed health surface.
4. **Smart rotation + fallback** — broken feed doesn't silence the news kind; healthy feeds keep ticking.

### Explicit non-goals

- **No `settings.news.categories[]`.** The persona's existing `skills[]` allowlist *is* the categorisation mechanism. A "tech persona" lists the tech feed slugs in `skills[]`. A station-wide "tech" concept would duplicate that.
- **No `/admin/news` route.** Everything lives in `/admin/skills`.
- **No separate rotation algorithm.** Rotation is emergent from independent skills with independent cooldowns.
- **No listener "what's in the news?" request channel.** Orthogonal — deferred to a follow-up that wires `/request` intents to direct-tool-call paths across any skill.
- **No bespoke `settings.news` block.** Everything that would have lived there now lives in `state/skills/news-*/SKILL.md`.

---

## Design

### 1. Default news skill replaces the built-in capability

After this lands, the built-in `news` entry in `CAPABILITIES` (`controller/src/skills/_agent.ts`) is deleted. The `getHeadlines` tool branch in `controller/src/llm/segment-tools.ts` (lines 47–67 on `develop`) is deleted with it.

The current implementation in `controller/src/skills/news.ts` — `fetchHeadlines()` and `hashHeadline()` — is **not** deleted. It moves into the templated RSS helper described in §2.

A first-party news skill ships with the install:

```yaml
# state/skills/news-bbc/SKILL.md
---
name: news-bbc
label: BBC News
cooldown: 45m
feed: http://feeds.bbci.co.uk/news/rss.xml
feedMaxItems: 10
feedFreshnessHours: 24
---
Read one fresh headline in a single sentence — half-distracted BBC 6 Music tone,
never an anchor voice, no editorialising, no "in other news".
```

No `tool.mjs` is needed — the loader sees `feed:` in frontmatter and substitutes the RSS helper (§2). The cooldown and brief are exactly today's values, so an out-of-the-box install behaves identically.

This file is scaffolded at boot if no `news-*` skill is present (see §6).

### 2. Loader extension: `feed:` frontmatter triggers the RSS helper

Goal: the common case (just an RSS URL) is a single-line SKILL.md change. No `tool.mjs` to write.

**Loader change** (`controller/src/skills/loader.ts`):

In `loadOne()`, after `parseFrontmatter()` and after the existing `loadToolFn()` call:

```ts
if (!toolFn && data.feed) {
  toolFn = makeRssFetcher({
    url: data.feed,
    maxItems: parseInt(data.feedMaxItems || '10', 10),
    freshnessHours: parseInt(data.feedFreshnessHours || '24', 10),
    slug: name,
  });
}
```

Precedence: if both `tool.mjs` and `feed:` exist, `tool.mjs` wins (operator override). Three new flat frontmatter keys (`feed`, `feedMaxItems`, `feedFreshnessHours`). All flat so the existing minimal YAML parser doesn't need to grow.

**The RSS helper** (`controller/src/skills/_rss-helper.ts` — new file):

A factory that returns the same `(ctx, state) => result` shape a `tool.mjs` would. Responsibilities:

- Accept both RSS 2.0 `<item>` and Atom `<entry>`.
- Add Atom title (often namespaced, often with attributes) and Atom `<summary>` / `<content>` fallback to title/description.
- Send `User-Agent: SUB/WAVE/<version> (+https://getsubwave.com)`.
- Parse `<pubDate>` (RSS) and `<updated>` (Atom); if `freshnessHours > 0`, drop items older than that.
- Read/write per-skill dedup state via the new state slot (§4): `state.seenHeadlines[hash] = airedMs`. LRU-cap at 200 entries.
- On `!res.ok` or unparseable body: return `{ available: false, error: <string> }` AND record the failure into `state.health` (§5).
- On success: return `{ available: true, headlines: [{ title, detail }, ...] }`. Same shape today's `getHeadlines` tool returns.

The helper reads its config (`url`, `maxItems`, `freshnessHours`) once at factory-call time. The `tool.mjs` wrapper in `segment-tools.ts` (existing) supplies the 8s timeout — no special treatment needed.

**Why not extend YAML to nested objects?** The existing parser is intentionally tiny (flat key/value, zero deps). Three new prefixed keys is a smaller blast radius than parser changes that every future skill author has to learn.

### 3. The "Add news feed" UI shortcut

Goal: an operator who couldn't get past `.env` editing can add a feed without ever leaving the browser.

**Backend** (`controller/src/routes/dj.ts` — the same file that holds `/dj/skills/rescan`):

- `POST /dj/skills/news/scaffold`
  - Body: `{ name, url, cooldown?: string, brief?: string }`
  - Validates: `name` non-empty, `url` parses as `http(s)://…`, optional `cooldown` matches the loader's pattern, optional `brief` non-empty.
  - Derives `slug = "news-" + kebab(name)`; rejects with 409 if `state/skills/<slug>/` exists.
  - Writes `state/skills/<slug>/SKILL.md` (template below).
  - Calls `loadCustomSkills()` directly (no `/rescan` round-trip).
  - Returns the freshly loaded skill row so the UI can render it without a refetch.

- `DELETE /dj/skills/:slug`
  - Guard: only allowed when `slug` starts with `news-`. Custom non-news skills are removed by the operator on the filesystem and a Rescan — the UI shortcut is opinionated about news only, so destructive UI actions stay scoped.
  - Removes `state/skills/<slug>/` (recursive) and calls `loadCustomSkills()`.

- `PUT /dj/skills/news/:slug`
  - Same body as POST. Overwrites the existing SKILL.md (preserves anything else in the folder, e.g. a `tool.mjs` an operator added later — but that overrides `feed:` per §2, so the UI shows the form in read-only mode in that case).

SKILL.md template the scaffold endpoint writes:

```yaml
---
name: {slug}
label: {name}
cooldown: {cooldown or "45m"}
feed: {url}
feedMaxItems: 10
feedFreshnessHours: 24
---
{brief or "Read one fresh headline in a single sentence — keep it conversational, in the station's voice. Skip a headline that is dull or stale; silence is fine."}
```

**Frontend** (`web/components/admin/SkillsPanel.tsx`):

Add an "Add news feed" button next to the existing **Rescan** button (already on this branch). It opens a modal — fields: `Display name`, `Feed URL`, `Cooldown` (default `45m`), `Brief` (textarea, prefilled with the default brief). On submit → POST → close on success / show error inline on failure.

Each existing `news-*` skill row gets two extras:
- A small **Edit** affordance opening the same modal in update mode (PUT).
- A small **Remove** affordance (only on `news-*` rows) with a confirm prompt → DELETE.

For non-news custom skills, the row stays as today (toggle + Run now + Rescan).

### 4. Per-skill persistent state slot

Currently `state` (a.k.a. `segmentState` in `controller/src/skills/_agent.ts`) is in-memory + module-scoped + shared across all skills. The RSS helper, the in-tree weather/curiosity/news-dedup logic, and any custom `tool.mjs` all read and write the same object.

Two changes in `_agent.ts`:

- Initialise lazily: `segmentState.skills = segmentState.skills || {}`. Each capability's tool — built-in or custom — receives `state.skills[name]` as its own scratch object. The loader's call site (`segment-tools.ts`) passes `state.skills[cap.kind]` (creating-if-absent) into the wrapped `tool.mjs`. No cross-skill collisions.

- Add a debounced (500ms) writer that persists `segmentState.skills` to `state/skill-state.json` on every mutation, and loads it once at boot. Truncate-on-load if the file is corrupt or unparseable — never fatal. Cap the on-disk file at 256 KB; if it grows past that, drop the largest skill slot with a logged warning (none of these slots should be large; this is a safety valve, not a feature).

The RSS helper uses this slot for `{ seenHeadlines: { hash: airedMs, ... }, health: {...} }`. After this, restart no longer re-burns headlines — the original loose end from issue #193 closes by itself.

The built-in `seenCuriosity`, `lastWeatherCondition`, `lastSearchedArtist` slots on `segmentState` (`_agent.ts:132-138`) stay where they are — the migration is opt-in per skill, not a forced relocation. Built-ins can adopt the slot later when their owners feel like it.

### 5. Per-skill health surface

Generic, not news-specific. The RSS helper happens to be the first user.

**Data shape** — every tool invocation writes:

```ts
state.skills[name].health = {
  lastInvokedAt: <unixMs>,
  lastOk: boolean,
  lastError: string | null,         // first 200 chars
  lastItemCount: number | null,     // null for non-data skills
  consecutiveFailures: number,
}
```

**Surface in the admin Skills response** — extend whatever `GET /dj/skills` returns on this branch with a `health` field on each skill row. Source: `segmentState.skills[name]?.health` if present.

**Surface in `/admin/skills`** — render a small status dot per row:
- grey: never invoked
- green: `lastOk && consecutiveFailures === 0`
- amber: `lastOk && consecutiveFailures >= 1` (last call was ok but earlier failures recent)
- red: `consecutiveFailures >= 3`

Hovering the dot shows `lastError` and the relative time of `lastInvokedAt`.

**Surface in `/debug`** — already exposes per-skill state in the catalog. Same fields rendered as JSON for power users.

### 6. Migration and env compatibility

On controller boot, *after* the pluggable-skills loader has finished its initial scan:

- **No `news-*` skill loaded AND `process.env.NEWS_FEED_URL` is set** → scaffold `state/skills/news-env/` from the env var's value (and `NEWS_MAX_ITEMS` if present). This preserves the 12-factor / GitOps story.
- **No `news-*` skill loaded AND no `NEWS_FEED_URL`** → scaffold `state/skills/news-bbc/` (the default in §1). Fresh installs are never silent on news.

Both scaffolds are idempotent — they check for the folder's existence first and do nothing if present. Operators who later delete or rename the folder won't have it re-created until they restart with no `news-*` skill at all, which matches "operator intent" semantics: if you've actively curated your skills, we stop second-guessing you.

**`.env.example`** keeps `NEWS_FEED_URL` documented but reframes the surrounding comment: *"convenience — seeds a default news skill named `news-env` if you haven't added a feed via the admin UI."*

**`CLAUDE.md` updates** — the "What this is" / commands section and the LLM/skills section both mention the built-in `news` capability. Both get a one-line update pointing at the pluggable-skills doc.

### 7. Out of scope (with reasons)

- **Listener "what's in the news?" `/request` channel.** Orthogonal: it's about routing listener intents to a *direct* tool call on a specific skill, not about how news airs autonomously. Belongs in a separate plan that touches `controller/src/routes/request.ts` and the matcher in `controller/src/llm/dj.ts`.
- **Schedule windows per feed (e.g. "tech news only Mon-Fri 7-9am").** The existing `window: commute` frontmatter on the branch is the precedent. Real cron windows are a fair follow-up — add `window:` as a tagged union (`any | commute | <cron>`) when there's an operator who actually wants it. YAGNI for now.
- **Feed categories as a station-wide concept.** Personas already serve this role.
- **Cross-feed dedup.** Each feed-skill dedupes itself; identical headlines across feeds (rare; usually wire copy) will each fire once, max. Trying to dedup across feeds means a global hash table, which adds coordination cost without a concrete operator complaint behind it.

---

## What changes, by file

The build order matters less than the dependency graph below — operators can split this across PRs if useful, but §4 is a precondition for §2's helper to persist dedup, and §1 depends on §6 (otherwise booting the new code on an existing install with no `news-*` folder yet silences news mid-flight).

| File | Change |
|---|---|
| `controller/src/skills/_agent.ts` | Delete `news` entry from `CAPABILITIES`. Initialise `segmentState.skills = {}`. Add debounced persist + boot-load for `state/skill-state.json`. Migration scaffolder (§6) called after `loadCustomSkills()`. |
| `controller/src/llm/segment-tools.ts` | Delete the `kinds.has('news')` branch. Wrap each custom tool with `state.skills[cap.kind]` slot (replacing the shared `state` arg). |
| `controller/src/skills/loader.ts` | Add `feed:` branch in `loadOne()` that calls the RSS helper factory when `tool.mjs` is absent. Pass through new `feedMaxItems` / `feedFreshnessHours`. |
| `controller/src/skills/_rss-helper.ts` | **New.** Factory returning a `tool.mjs`-shaped function. RSS 2.0 + Atom, User-Agent, freshness filter, persistent dedup via state slot, health record. |
| `controller/src/skills/news.ts` | Delete file (its logic is now inside `_rss-helper.ts`). |
| `controller/src/routes/dj.ts` | Add `POST /dj/skills/news/scaffold`, `PUT /dj/skills/news/:slug`, `DELETE /dj/skills/:slug` (guarded to `news-*`). |
| `web/components/admin/SkillsPanel.tsx` | Add "Add news feed" button + modal. Add Edit/Remove buttons on `news-*` rows. Health dot per row. |
| `state/skills/news-bbc/SKILL.md` | New default skill, scaffolded by §6 migrator at boot rather than committed. Documented in `docs/custom-skills.md` as an example. |
| `docs/custom-skills.md` | Document the `feed:` frontmatter key and the news scaffolding path. |
| `.env.example` | Re-comment `NEWS_FEED_URL` to mention the `news-env` scaffolding semantic. |
| `CLAUDE.md` | One-line update where the built-in `news` capability is described. |

## Verification (when this is implemented)

1. **Fresh install, no env.** Boot. `state/skills/news-bbc/` is auto-created; `/admin/skills` shows it enabled. Next segment tick fires a BBC headline.
2. **Fresh install with `NEWS_FEED_URL=https://www.eurogamer.net/feed/news`.** Boot. `state/skills/news-env/` is auto-created with that URL; `/admin/skills` shows it; first tick fires an Eurogamer headline.
3. **Add second feed via UI.** With BBC already running, click "Add news feed" → name "Guardian Tech" → URL `https://www.theguardian.com/uk/technology/rss`. Save. Row appears, enabled. Within one tick cycle, fires Guardian headlines too.
4. **Atom feed works.** Add a GitHub releases atom feed (or any known Atom URL). Health dot is green; `/debug` shows `lastItemCount > 0`.
5. **Broken URL surfaces.** Add `https://example.com/not-a-feed`. Within 5 min, the row's health dot turns red; hover shows the parse error. Other news skills keep ticking.
6. **Persona allowlist filters feeds.** Configure two personas — `breakfast` lists `news-bbc`, `late-night` lists `news-guardian-tech`. Confirm in the listener UI that the on-air persona controls which feed is read.
7. **Restart doesn't re-burn headlines.** Note `state.skills["news-bbc"].seenHeadlines` size in `/debug`. Restart the controller. `/debug` shows the same size (loaded from `state/skill-state.json`). The next news tick does not re-read recently-aired headlines.
8. **Delete a feed via UI.** Click Remove on `news-guardian-tech`. Row vanishes; on-disk folder gone. Boot again — it stays gone (the migrator only seeds defaults when *no* `news-*` skill exists).
9. **Lint clean.** `cd controller && npm run lint` and `cd web && npm run lint` both pass.

## Open questions

- **Per-skill state slot scope creep.** §4 introduces a new contract (`state.skills[name]` + on-disk persistence). It's strictly additive and lands cleanly, but it's also a feature every future custom-skill author has to know about. Worth a short paragraph in `docs/custom-skills.md` as part of this work — not a separate plan.
- **Health dot semantics on never-invoked skills.** Currently "grey." Could be "amber" to nudge the operator that an enabled skill isn't being picked up by the agent (e.g. wrong persona allowlist). Probably grey is fine; revisit when there's an operator confused by silence.
- **What happens if the operator hand-edits `state/skills/news-bbc/SKILL.md` *and* uses the UI Edit form?** UI Edit overwrites. We could detect divergence (read the file, compare to the previous template, refuse to overwrite if it's been hand-edited), but that's more cleverness than the wider operator base wants. Document it: "Edit through the UI overwrites the whole file. If you've made manual changes, edit the file directly and hit Rescan."
