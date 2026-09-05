# Custom skills

SUB/WAVE's **skills** are the things the AI DJ does *between* tracks — a weather
check, a headline, a dig on the song playing. The built-in ones ship as
read-only templates under `controller/src/skills/builtins/<kind>/` and are
**seeded as full, editable skills** — both `SKILL.md` **and** `tool.mjs` — into
`state/skills/<kind>/` on first boot. From then on `state/skills/` is the single
place skills load from: a built-in is just a pre-installed skill, no different
from one you add yourself, so you can change what it says, which feed it reads,
**and how it fetches its data** — without touching the codebase. Add entirely new
skills the same way: from the admin UI, or by dropping a folder into
`state/skills/`.

> **TL;DR — want a brand-new segment?** Open **/admin/skills → New skill**, fill in
> a name, a brief, and a cooldown, then **Create skill**. It writes
> `state/skills/<slug>/SKILL.md` for you (and arrives **disabled** — enable it when
> you're happy). Custom skills can also be **edited** and **deleted** from the same
> page. The form is prompt-only; a `tool.mjs` data fetcher is still a disk-drop (see
> [tool.mjs (optional)](#toolmjs-optional) below).

> **TL;DR — News reads UK/BBC and you want something local?** Open
> **/admin/skills → News → Edit**, paste your own RSS feed URL and rewrite the
> brief, then Save. (Or edit `state/skills/news/SKILL.md` directly and hit Rescan.)

This borrows the *format* of [Anthropic's skills](https://github.com/anthropics/skills)
— a `SKILL.md` with YAML frontmatter and a markdown body, plus optional code —
but **not** their meaning. A SUB/WAVE skill is exactly one thing: a between-track
**spoken segment**. (You can't drop in `anthropics/skills/pdf` and have it do
anything — those manipulate documents.)

## Layout

```
state/skills/
  moon-phase/
    SKILL.md      # frontmatter (→ metadata) + body (→ the DJ's brief)
    tool.mjs      # OPTIONAL: a data fetcher, wrapped as a tool the DJ can call
```

Three copy-ready examples live in [`docs/examples/skills`](./examples/skills) —
copy a folder into `state/skills/` and hit **Rescan** in the admin Skills page:

- [`moon-phase`](./examples/skills/moon-phase) — the small end. No settings, no
  network, no memory: it works out the lunar phase from the date and returns it.
- [`sunset`](./examples/skills/sunset) — the other end. Operator settings
  (`configFields`), a call out to a public API, and `state` so it marks the
  sunset once a day rather than every time it fires. Fill in its coordinates in
  the edit sheet before it will say anything.
- [`todoist`](./examples/skills/todoist) — the same shape against an
  **authenticated** API: the DJ picks one outstanding task off your Todoist list
  and dares the room to go and do it before the next record ends. Put
  `TODOIST_API_TOKEN` in the root `.env` — the whole file is passed into the
  controller, so any key you add there reaches `process.env` — then set the
  filter in the edit sheet. Each task is burned on read for the rest of the day,
  so it nudges rather than nags.

## SKILL.md

```yaml
---
name: moon-phase          # the slug / "kind" (defaults to the folder name)
label: Moon phase         # human label in /admin/skills (defaults to title-cased name)
cooldown: 6h              # hard min gap between autonomous firings — "90m" | "6h" | "2d" | "45" (bare = minutes)
cron: 0 * * * *           # OPTIONAL: fire on a fixed schedule instead of/alongside the cooldown gate (see below)
cronOnly: true            # OPTIONAL: with a cron: set, withhold this skill from random autonomous picks entirely
cohosts: true             # OPTIONAL: host + every active guest each speak in their own voice (see below)
window: any               # "any" (default) | "commute" — only offered during commute hours
context: time, festival   # OPTIONAL: which "right now" fields this segment may mention (see below)
requiresKey: SOME_API_KEY # OPTIONAL: env var the skill needs; if unset, the skill stays inert
toolDescription: ...      # OPTIONAL: how the DJ-facing tool is described (only matters with tool.mjs)
---
The markdown body is the DJ's brief for this segment. Keep it tight: what to
say, in what tone, and — importantly — when to stay silent. The agent reads
this verbatim. One short sentence on air is the norm.
```

Only a **non-empty body** is required; every frontmatter key has a default. The
body becomes the per-segment briefing the DJ agent follows (the same role the
inline `desc:` strings play for built-in skills) and the description shown in the
admin UI.

The block is parsed as **real YAML**, so the ordinary things work: inline `#`
comments like the ones above, quoted values (`label: "Tonight: the moon"`), and
lists written either way —

```yaml
tags: [late-night, factual]
# ...is the same as...
tags:
  - late-night
  - factual
# ...is the same as...
tags: late-night, factual
```

Values are read as text whatever their YAML type, so `feedMaxItems: 6` and
`feedMaxItems: "6"` are identical. Nested maps have no meaning here and are
ignored. A block that isn't valid YAML — most often an unquoted colon in a
value — still loads, read with the old line-by-line parser, and logs a warning
naming the file.

### `cohosts: true` — one contribution from every host

`cohosts: true` turns the skill from one DJ line into a co-hosted discussion. It
uses the **active scheduled show's roster**: the show's host followed by every
resolved `guestPersonaIds` co-host. A skill cannot choose arbitrary personas, and
the existing enable toggle and persona assignment remain keyed to the host.

The discussion contains exactly one contribution per live roster member, in that
order. The model is instructed to give each person **2–5 short sentences**, in
that persona's own character, as one coherent conversation. Do not put labels
such as `Mara:` in the brief or returned speech: speaker identity is structured
metadata, and each contribution is rendered through that persona's own TTS
configuration and fallback. The clips are pre-rendered as a complete exchange
before any reaches air, then played back-to-back rather than mixed.

A co-hosted skill only runs while an active show has a host and at least one
resolved guest. Autonomous selection withholds it on a solo/off-show hour; its
cron logs `requires a co-hosted show`; **Run now**, MCP and programme use stand
down with that same reason before any model or TTS work — reported, not an
error, exactly like a data-backed skill that found nothing to say. Ordinary
skills, including ones with no `cohosts` field, keep the existing one-speaker
path.

If the skill has a `tool.mjs`, the co-hosted discussion gathers its data the same
way every other segment does: the skill's own tool loop when `llm.pickerAgent`
is on, and a code-driven fetch plus one structured call when it is off (pool
mode, for models that aren't trusted with tool loops). Data-backed skills must
obtain usable source data before anyone speaks; `{ available: false }` or a tool
error stands the whole exchange down instead of letting several personas amplify
an invented fact.

Set it in the admin editor with **Co-hosted discussion**, or in frontmatter:

```yaml
---
name: case-discussion
label: Case discussion
cohosts: true
---
Find one well-sourced historical case and have the hosts discuss the outcome and
investigation. Give every host a distinct perspective; do not write name labels.
```

### `context:` — what the segment is allowed to mention

`context:` is a comma-separated allow-list of the "right now" fields the DJ may
weave into this segment. Valid fields:

| field | what it surfaces |
| --- | --- |
| `date` | day of week, date, season |
| `clock` | local clock time, plus weekend / late-night / commute tags |
| `time` | the daypart and its vibe (e.g. "morning, productive") |
| `weather` | current condition, temperature, location |
| `festival` | the named festival, if today is one |
| `show` | the scheduled show on air, if any |
| `listeners` | how many people are tuned in |

**Leave `context:` off and the segment gets the default profile: everything
*except* `weather`.** This is deliberate — ambient weather stapled to every
break made the DJ comically weather-heavy ([#471](https://github.com/perminder-klair/subwave/issues/471)).
Weather now reaches air through the dedicated **weather** skill, which is
cooldown- and change-gated, rather than as filler everywhere.

Tick `weather` back on for a skill where it's genuinely topical — e.g. a
commute-conditions segment:

```yaml
---
name: commute-conditions
label: Commute conditions
window: commute
context: time, clock, weather
---
A quick word on what the drive looks like right now — lean on the weather and
the hour. One sentence; skip it if nothing's notable.
```

You can also set this from the admin UI: **/admin/skills → Edit** shows a
tick-box per field. An empty selection resets the skill to the default profile.

### `cron:` — fire on a fixed schedule

`cron:` is an OPTIONAL standard 5-field cron expression (`"0 * * * *"` = top of
every hour, `"*/30 * * * *"` = every 30 minutes); a leading seconds field is
accepted too (`"0 0 8 * * *"`). When set, the scheduler registers a dedicated
timer for that skill and fires it the moment the expression matches — bypassing
the cooldown and the DJ's frequency floor. Leave it blank (the default) and the
skill only airs through the normal cooldown / frequency-gated segment tick.

The expression runs in the station's own timezone (Settings → Station), so a
`cron: 0 8 * * *` fires at 8am local time wherever the station is configured to
be, not the container's UTC clock. Changing the station timezone re-registers
every skill cron immediately — no restart, no rescan. A skill can carry both a
`cooldown:` and a `cron:` — the cooldown still applies to any *autonomous*
firing from the segment tick, while the cron timer ignores it.

An expression saved through the admin UI (or installed from the community
catalog) is **refused** if it isn't one the scheduler can run, with the error on
the field. One typed into `SKILL.md` by hand is logged and skipped instead, so a
typo costs the skill its timer rather than stopping it loading — the admin
editor flags it the next time you open that skill.

Set it from the admin UI too: **/admin/skills → Edit → Cron timer**.

**A cron speaks whenever it has something to speak from.** This is the thing to
get right before adding one. The autonomous segment tick asks the agent whether
to air at all, and silence is a first-class answer it takes whenever the data is
dull or unchanged. A cron takes the same path as **Run now**, which is *forced*:
the segment is required to produce a line, and the model is not offered a "stay
silent" option.

The one exception is the case where there is nothing to write from. If your
skill has a `tool.mjs` and it returns `{ available: false }` or fails, the
forced run **stands down** rather than ordering a line anyway: nothing airs, and
the reason is logged (and returned to **Run now** as `aired: false`). Without
that, a skill handed no facts and told it must speak can only invent them — which
is exactly what the web-search skill did when a search came back empty
([#1412](https://github.com/perminder-klair/subwave/issues/1412)). Opt out with
`export const requiresData = false` when your skill writes its own material and
`{ available: false }` merely means "no external item this time" — that is what
the built-in `curiosity` does.

On the autonomous pool-mode tick, grounded `{ available: false }` results are
skipped before the LLM call and logged with the selected skill. The scheduler
then backs that skill off in memory for the shorter of its configured cooldown
or 15 minutes, so an empty source does not consume retrieval work again on the
next five-minute tick. Successful-air cooldowns remain separate.

So a cron suits a skill that is worth hearing at a fixed moment every time — a
morning bulletin, a sign-off, a running joke tied to a particular hour. It still
suits a skill that speaks *only when something is notable* less well: it fires
on the clock rather than on the news, so it will keep asking at 8am whether
there is anything to say. It just no longer makes something up when the answer
is no. The example skills in
[`docs/examples/skills`](examples/skills) ship without a `cron:` for that reason
— `moon-phase` is meant to skip an unremarkable gibbous, and `sunset` tracks a
time that moves through the year, so pinning it to a fixed clock reading would be
wrong in a different way. Leave those on `cooldown:` and let the director decide.

`todoist` is the one that goes either way, which is why its frontmatter carries
the line commented out: on `cooldown:` it is a nudge that turns up when it turns
up, and with `cron: 0 8 * * *` + `cronOnly: true` it becomes a fixed morning
alarm that never fires at random. Pick the one you actually want to hear.

**Daylight saving.** A normal daily cron survives a clock change: `cron: 0 8 * * *`
fires once at 08:00 local on the spring-forward day, the autumn day, and every
ordinary day, which is the whole point of running in the station zone. Two edge
cases fall out of the scheduler and are worth knowing about:

- On the **autumn** change, the hour that repeats (in the UK, 01:00–01:59) is
  skipped: a `*/10` cron fires 19 times that day instead of 25, and an hourly one
  misses a single beat. Nothing fires twice, which is the safer direction — the
  same guard that drops the hour is what stops the duplicate.
- On the **spring** change, a cron pointed at a time that does not exist that day
  (again in the UK, anything in 01:00–01:59) simply does not fire, silently.

So avoid pinning a skill to the small hours if it genuinely has to run every day,
and expect a once-a-year gap otherwise. This is `node-cron` 3.x behaviour rather
than anything SUB/WAVE decides, and it applies to every cron in the scheduler,
not only skill timers.

**A cron timer is not the same override as "Run now".** Pressing **Run now** is
an explicit operator action and fires whatever it names. A timer firing on its
own is autonomous, so it stands down exactly where the normal segment tick
does: the station voice switch is off (`tts.enabled: false`, "music only"), a
programme episode is on air, nobody is listening, the daily LLM token budget is
spent — and, because they're rules about the skill itself, if the skill is
**disabled** or isn't assigned to the **on-air DJ**. That last pair matters for
an imported skill: a zip import or a community install arrives disabled pending
your review, and a `cron:` line in it does not air anything until you enable it.
Each stand-down is written to the booth log with its reason, since a silent
timer is otherwise undiagnosable.

**A `cron:` timer is a second trigger, not a replacement one.** By default the
skill stays eligible for the normal autonomous segment tick too, off-cooldown,
same as any other skill — so a skill written around a specific moment (e.g. a
running joke tied to 7:10) can still fire at a random moment in between. Set
`cronOnly: true` to withhold it from that random selection entirely; it then
airs ONLY when its cron timer ticks (or via **Run now**, which always bypasses
every gate). `cronOnly` on its own, without a `cron:` expression, means the
skill never fires autonomously at all.

For a **new** skill the `name` must be a lowercase slug that isn't a built-in kind
(`weather`, `news`, `now-playing-dig`, `curiosity`, `album-anniversary`, `library-deep-cut`,
`web-search`). Naming a folder after a built-in kind instead *edits* that built-in —
see [Editing the built-in skills](#editing-the-built-in-skills). Bad frontmatter is
logged and skipped — it never crashes the controller.

## tool.mjs (optional)

If present, the default export is wrapped as an [AI SDK](https://sdk.vercel.ai)
tool the segment director can call **before** writing the line. This is the
**exact same mechanism the built-ins use** — the seven shipped skills are just
directories with a `SKILL.md` and a `tool.mjs`, loaded the same way as yours.

```js
export default async function (ctx, state, services, config, input) {
  // ctx      — the moment: { time, weather, festival, dominantMood, clock }
  // state    — cross-tick dedup memory (persists between firings)
  // services — the curated station facade (see below)
  // config   — this skill's own SKILL.md frontmatter (e.g. a custom `feed:`)
  // input    — the agent's values for your declared `inputs` (see below); {}
  //            when you declare none
  // Return any JSON-serialisable object. The `{ available: false }` convention
  // tells the agent there's nothing worth airing right now.
  return { available: true, foo: 'bar' };
}

// OPTIONAL: a richer tool description shown to the agent (else a generic one).
export const description = 'Fetch X for the … segment.';

// OPTIONAL: gate the whole skill on a runtime condition — when this returns
// false the skill is never even offered (e.g. no search provider configured).
export const ready = (services) => services.searchReady();

// OPTIONAL: opt out of the grounding rule. By default a skill with a tool
// STANDS DOWN on a forced run (Run now, cron, programme feature) when this tool
// returns `{ available: false }` or throws — no data, no segment, rather than
// an invented one. Set this to false when your skill writes its own material
// and `{ available: false }` just means "nothing external this time".
// An operator can settle it per install with a `requiresData:` frontmatter line,
// which wins over this.
export const requiresData = false;

// OPTIONAL: agent-steerable parameters — a flat { name: description } object of
// string params. The agent may pass a value or null for each; handle null by
// falling back to your own default (see the web-search built-in's `query`).
// Without this export the tool is zero-arg, which small models handle best —
// only declare inputs the agent genuinely benefits from steering.
export const inputs = { query: 'what to search for; null for the default dig' };

// OPTIONAL: operator knobs — the settings this skill gets its own fields for in
// /admin/skills. Values are stored in this skill's OWN SKILL.md frontmatter and
// arrive back as `config`, so there's nothing else to wire up. Declaring them
// HERE (rather than in the controller) is what makes a copy of the skill keep
// its settings: a duplicate copies tool.mjs verbatim, name and all.
export const configFields = {
  feed:         { type: 'url',    label: 'News feed · RSS 2.0', placeholder: 'https://…/rss.xml' },
  feedMaxItems: { type: 'number', label: 'Max items', min: 1, max: 50, integer: true },
};
```

**`configFields` reference.** A flat `{ key: { … } }` map, up to 8 entries per
skill. Each entry takes:

| field | meaning |
|---|---|
| `type` | `text` (default), `url` (http/https only), or `number` |
| `label` | the form label; derived from the key when omitted |
| `placeholder` / `hint` | optional form affordances |
| `min` / `max` / `integer` | `number` only — bounds, and whether fractions are refused |

Keys must be `letters, digits, _` starting with a letter, and can't shadow a key
the editor already owns (`name`, `label`, `cooldown`, `cron`, `cronOnly`,
`cohosts`, `context`, `window`, `requiresKey`, `tags`, `toolDescription`,
`brief`). A malformed declaration is
narrowed away rather than breaking the skill — the skill still loads and airs, it
just shows no settings. A bad *value* is the opposite: the save fails loudly with
a 400 rather than dropping the knob you just set.

You don't have to declare a knob to use one — a tool can read any frontmatter key
off `config`. Declaring it is what gets you a form field instead of a hand edit.
Either way the editor preserves keys it doesn't own, so a hand-authored line
survives a save from the admin form.

### `services` — the station facade

The one way a tool reaches the world, so built-in and custom skills run on
identical footing. It's read-mostly (no settings writes, no secrets):

| call | what it does |
|---|---|
| `services.searchWeb(query, opts?)` | web search via the configured provider (DuckDuckGo / Tavily / Brave / SearXNG) |
| `services.searchReady()` | `true` when a search provider is usable |
| `services.nowPlaying()` | the track on air — `{ artist, title, album, year, id }` or `null` |
| `services.recentPlays(hours)` | play-log dedup sets `{ ids, keys }` over the last *hours* |
| `services.library.getArtist(id)` / `.getAlbum(id)` / `.searchArtists(name, opts?)` | Navidrome/Subsonic reads |
| `services.onThisDay()` | Wikipedia "on this day" events for today |
| `services.fetchHeadlines({ feedUrl?, maxItems? })` | fetch + parse an RSS feed |
| `services.recall.seen(key)` / `.remember(key)` | durable, cross-restart dedup ledger |
| `services.log(msg)` | append a line to the station event log |

Every skill's `tool.mjs` is **timeout-guarded (8 s)** and any throw degrades
cleanly to "no data" — a slow or broken skill can never hang the between-track
tick. This applies to the seeded built-ins too (their network calls — search,
RSS, on-this-day — must finish within 8 s or that tick simply yields no segment).
With no `tool.mjs`, the skill is pure generation: the DJ writes from the brief
alone.

> **Security.** A `tool.mjs` runs operator-supplied code inside the controller
> container, and `services` lets it spend your search-provider quota and read
> your library — the same trust model as a locally-installed Claude Code skill.
> Only drop in code you've read and trust. (Skills you add stay disabled until
> you enable them in `/admin/skills`.)

## Editing the built-in skills

The 7 built-ins — `weather`, `news`, `now-playing-dig`, `curiosity`, `album-anniversary`,
`library-deep-cut`, `web-search` — ship as read-only templates under
`controller/src/skills/builtins/<kind>/` and are **seeded** into
`state/skills/<kind>/` — both `SKILL.md` and `tool.mjs` — the first time the
controller boots. After that they're ordinary editable skills: edit the brief /
cooldown / label / `context:` in `/admin/skills`, and edit the **`tool.mjs` on
disk + Rescan** exactly as you would for a skill you wrote. The seeded files carry
a `context:` line showing each built-in's current fields — `weather` ships with
weather ticked on, the rest with the default (no-weather) profile.

How a built-in still differs from a skill you add:

- **Enabled by default.** A built-in airs out of the box; a *new* skill starts in
  the discovered-but-disabled state until you enable it.
- **Can't be deleted, only disabled.** Toggle it off to silence it. If you delete
  its folder on disk, the seeder restores it (both files) on the next boot.
- **Reset to default.** `/admin/skills → <built-in> → ↺ Reset to default`
  overwrites both `SKILL.md` and `tool.mjs` from the shipped template. This is the
  way back from a broken edit — and the way to pull in a newer image's `tool.mjs`
  (the seeder never overwrites a file that already exists, so a shipped fix only
  reaches an existing install when you reset).

> The seeder never clobbers a file that already exists, so your edits survive a
> restart and an upgrade. Only **Reset to default** (or deleting the file on disk)
> brings the shipped version back.

### News: swapping the feed

The `news` skill's `tool.mjs` declares two knobs (`configFields`, above), so
**/admin/skills → News → Edit** carries a feed field and a max-items field. They
are stored as two extra frontmatter keys, editable on disk just as well:

```yaml
---
name: news
label: News headlines
cooldown: 45m
feed: https://www.npr.org/rss/rss.php?id=1001   # any RSS 2.0 feed
feedMaxItems: 10
---
Read one fresh headline in a single sentence — keep it conversational, in the
station's voice. Skip a headline that is dull or stale; silence is fine.
```

> **Heads-up.** The parser handles **RSS 2.0** (`<item>`) feeds. **Atom** feeds
> (`<entry>`) return zero items today — use an RSS URL.

`NEWS_FEED_URL` / `NEWS_MAX_ITEMS` in `.env` only *seed* this file on the very first
boot. Once `state/skills/news/SKILL.md` exists, **the file wins** — change the feed
there (or in `/admin/skills`), not in `.env`.

**Running a second news source** is just a copy: export the skill, rename it in
both the `.md` and the `.zip`, re-import, and point its feed somewhere else. The
knobs ride in `tool.mjs`, so the copy gets its own feed field under its own name.

## Lifecycle

- **Discovered but disabled.** A freshly dropped skill shows up in
  `/admin/skills` toggled **off**. It cannot air — autonomously or otherwise —
  until you enable it there. Merely dropping a folder never puts unreviewed
  content (or code) on air.
- **Loaded at boot**, and on demand via the **Rescan state/skills** button on
  the admin Skills page (`POST /api/dj/skills/rescan`). Rescan picks up new
  folders and edits to `SKILL.md` / `tool.mjs` without a controller restart.
- **Persona ownership still applies.** Like built-in skills, a custom skill only
  fires autonomously when it's enabled *and* assigned to the persona on air
  (Personas page). **Run now** is an operator override that bypasses the toggle,
  the persona assignment, the frequency gate, and the cooldown. A co-hosted skill's active host-plus-guest roster requirement is not
  bypassed.

## Sharing skills

Three ways to move a skill between stations, sorted from most-reviewed to
most-direct.

### The community catalog

`/admin/skills` has a **Community** button (next to **New skill**) that lists the
[community catalog](community.md) — skills (plus personas and shows) contributed
by other operators. It's fetched **live** from the
[`getsubwave/community`](https://github.com/getsubwave/community)
repo, so it isn't tied to your controller version. **Install** copies one into
`state/skills/` as an ordinary custom skill — **disabled on arrival**, for you to
read before it airs. The catalog is **prompt-only by contract**: no `tool.mjs` is
ever shipped or written, so installing from it never runs third-party code.

### Sharing your own

Any **prompt-only** custom skill (no `tool.mjs`) shows a **Share to community**
button. It opens a prefilled GitHub Issue Form in the
[`getsubwave/community`](https://github.com/getsubwave/community)
repo; a bot validates the slug, reserved names, and context fields, then opens a
one-file PR adding `skills/<slug>/SKILL.md` to the catalog — no fork, no code.
Once a maintainer merges it, the catalog rebuilds and it goes **live on every
station shortly after — no release, and no image pull needed**, because every
station fetches the catalog live (see [`docs/community.md`](community.md)). A skill
that carries a `tool.mjs` can't be shared this way; use a zip.

The bot also stamps **provenance** into the frontmatter it writes:
`submittedBy` (the GitHub login that filed the issue), `dateAdded` (when it first
entered the catalog), and `dateModified` (each time the PR is refreshed).
`dateAdded` is preserved across issue edits — only `dateModified` moves — so an
approved skill keeps its original credit line. The Community modal shows this
under each entry ("by @who · added … · updated …").

### Zip export / import

For a direct operator-to-operator handoff, the skill edit sheet has **↓ Export**
(`GET /api/dj/skills/:slug/export`) that streams a `.zip` of `SKILL.md` plus
`tool.mjs` if present. The **Import .zip** button in the Community modal
(`POST /api/dj/skills/import`) takes it back in, deriving the slug from the
bundle's `name:`.

> **A zip may carry code.** Unlike the reviewed catalog, an imported `.zip` can
> include a `tool.mjs` — a direct action on your own box, the same trust as
> dropping a folder in by hand or restoring a backup. Imports arrive **disabled**;
> when the bundle has a tool, the response flags it so the UI can warn you before
> you enable it. (Hardened against zip-slip; 5 MB upload cap, only `SKILL.md` +
> `tool.mjs` are extracted. Reserved names and re-imports are rejected.)
