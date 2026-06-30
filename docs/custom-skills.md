# Custom skills

SUB/WAVE's **skills** are the things the AI DJ does *between* tracks — a weather
check, a headline, a dig on the song playing. The built-in ones are defined in
`controller/src/skills/_agent.ts` and **scaffolded as editable files** into
`state/skills/<kind>/SKILL.md` on first boot — so you can change what they say (and,
for news, which feed they read) without touching the codebase. You can also add
entirely new skills — either from the admin UI or by dropping a folder into
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

A copy-ready example lives in [`docs/examples/skills/moon-phase`](./examples/skills/moon-phase).
Copy that folder into `state/skills/` and hit **Rescan** in the admin Skills page.

## SKILL.md

```yaml
---
name: moon-phase          # the slug / "kind" (defaults to the folder name)
label: Moon phase         # human label in /admin/skills (defaults to title-cased name)
cooldown: 6h              # hard min gap between autonomous firings — "90m" | "6h" | "2d" | "45" (bare = minutes)
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

For a **new** skill the `name` must be a lowercase slug that isn't a built-in kind
(`weather`, `news`, `now-playing-dig`, `curiosity`, `album-anniversary`, `library-deep-cut`,
`web-search`). Naming a folder after a built-in kind instead *edits* that built-in —
see [Editing the built-in skills](#editing-the-built-in-skills). Bad frontmatter is
logged and skipped — it never crashes the controller.

## tool.mjs (optional)

If present, the default export is wrapped as an [AI SDK](https://sdk.vercel.ai)
tool the segment director can call **before** writing the line — the same
mechanism the built-in weather/news skills use to look at real data.

```js
export default async function (ctx, state) {
  // ctx   — the moment: { time, weather, festival, dominantMood, clock }
  // state — cross-tick dedup memory (persists between firings)
  // Return any JSON-serialisable object. The `{ available: false }` convention
  // tells the agent there's nothing worth airing right now.
  return { available: true, foo: 'bar' };
}
```

The call is **timeout-guarded (8 s)** and any throw degrades cleanly to "no
data" — a slow or broken skill can never hang the between-track tick. With no
`tool.mjs`, the skill is pure generation: the DJ writes from the brief alone,
with no live data to look at.

> **Security.** `tool.mjs` runs operator-supplied code inside the controller
> container — the same trust model as a locally-installed Claude Code skill.
> Only drop in code you've read and trust.

## Editing the built-in skills

The 7 built-ins — `weather`, `news`, `now-playing-dig`, `curiosity`, `album-anniversary`,
`library-deep-cut`, `web-search` — are written into `state/skills/<kind>/SKILL.md`
the first time the controller boots. A file **named after a built-in kind** is an
**override**: it edits that skill's brief / cooldown / label / `context:` in place
rather than being rejected as a name clash. (For everything else, a built-in kind in
`name:` is still off-limits.) The scaffolded files already carry a `context:` line
showing each built-in's current fields — `weather` ships with weather ticked on, the
rest with the default (no-weather) profile.

Differences from a custom skill:

- **The body may be empty.** An empty brief means "keep the built-in default" — handy
  when you only want to change the `feed:` or `cooldown` and leave the wording alone.
- **No `tool.mjs`.** Built-ins already have their data tools wired in code (by kind),
  so a `tool.mjs` dropped next to a built-in override is ignored.
- **Stays enabled-by-default.** Editing a built-in doesn't flip it to the
  discovered-but-disabled state that *new* custom skills start in.

### News: swapping the feed

The `news` skill takes two extra frontmatter keys:

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
  the persona assignment, the frequency gate, and the cooldown.
