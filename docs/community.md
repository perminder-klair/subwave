# The community catalog

SUB/WAVE has a **community catalog** — a shared exchange of DJ **skills**,
**personas**, **shows**, and a public **station directory** that any operator can
contribute to and install from. It lives in its own repo,
**[`getsubwave/subwave-community`](https://github.com/getsubwave/subwave-community)**,
separate from the code. Every running station fetches it **live**, so anything
merged into the catalog shows up in every station's admin panel within the hour —
no software release, no image pull, no redeploy.

The split is deliberate: shipping community content used to mean baking it into
the controller image and waiting for the next release. Now the catalog moves on
its own clock. The code repo ships software; the community repo ships content.

## What's in it

One entry per file or folder, so contributions never collide on merge:

| Kind | Path in the community repo | Installs as |
|---|---|---|
| **Skills** | `skills/<slug>/SKILL.md` | a between-track segment in `/admin/skills` → Community |
| **Personas** | `personas/<slug>/PERSONA.md` | a roster DJ in `/admin/personas` → Community |
| **Shows** | `shows/<slug>/SHOW.md` | a show template in `/admin/shows` → Community |
| **Stations** | `stations/<slug>.json` | a pin on the public [stations map](https://www.getsubwave.com/stations) |

A folder or file's name **is** its slug: lowercase, starts with a letter or
digit, then letters/digits/hyphens, up to 49 characters
(`/^[a-z0-9][a-z0-9-]{0,48}$/`). For skills, personas, and shows the frontmatter
`name:` must equal that slug.

## How stations consume it

A CI job in the community repo compiles every entry into one **`catalog.json`**
at the repo root on each push to `main`, and jsDelivr serves it from the CDN:

```
https://cdn.jsdelivr.net/gh/getsubwave/subwave-community@main/catalog.json
```

Inside the controller, `controller/src/community/registry.ts` is the single fetch
path. It:

- **Memoises the catalog for ~30 minutes.** The first admin panel that needs it
  triggers the fetch; the rest read the cached copy. `POST /api/community/refresh`
  (admin) busts the cache immediately when you want the newest entries without
  waiting out the TTL.
- **Degrades to empty when unreachable.** If jsDelivr or the repo is down, the
  registry returns an empty catalog and logs it — the Community tabs simply show
  nothing to install. **The station keeps broadcasting either way.** The catalog
  is a discovery convenience, never a runtime dependency.
- **Honours an override.** Set `COMMUNITY_CATALOG_URL` in the controller's `.env`
  to point at a fork, a mirror, or a self-hosted `catalog.json` (for a private
  or air-gapped exchange). Unset, it uses the jsDelivr URL above.

Because the fetch is live, the loop from "PR merged" to "installable on every
station" is just the catalog rebuild plus one cache window — not a release.

## How to contribute

The easy path needs **no fork and no YAML by hand**. Open one of the issue forms
in the community repo, fill in the fields, and a bot turns your answers into a
one-file pull request for a maintainer to review:

- [Add a skill](https://github.com/getsubwave/subwave-community/issues/new?template=add-skill.yml)
- [Add a persona](https://github.com/getsubwave/subwave-community/issues/new?template=add-persona.yml)
- [Add a show](https://github.com/getsubwave/subwave-community/issues/new?template=add-show.yml)
- [Add your station](https://github.com/getsubwave/subwave-community/issues/new?template=add-station.yml)

Prefer to open the PR yourself? Fork the community repo, drop your one file or
folder into the right directory, run `node scripts/build-catalog.mjs --check` to
validate it, and open a PR against `main`. Either way a maintainer reviews it and
`catalog.json` rebuilds automatically on merge. Full schemas and validation rules
live in the community repo's
[`CONTRIBUTING.md`](https://github.com/getsubwave/subwave-community/blob/main/CONTRIBUTING.md);
the summary below tracks it.

**Provenance is stamped for you.** The submission bot fills in `submittedBy` (the
GitHub login that filed the issue), `dateAdded` (when the entry first landed), and
`dateModified` (each time the PR is refreshed). Leave those fields out when
hand-authoring — a maintainer adds them. `dateAdded` is preserved across edits so
an approved entry keeps its original credit line, which the Community modals show
under each item ("by @who · added … · updated …").

## How to install

Every admin panel that maps to a catalog kind has a **Community** button:

- **`/admin/skills` → Community** — install a between-track segment.
- **`/admin/personas` → Community** — add a DJ character to your roster.
- **`/admin/shows` → Community** — drop in a show template, then bind it to a
  schedule slot.

Installing **copies** the entry into your station's own `state/` as an ordinary
local item — **disabled on arrival**, so you read it before it goes on air. From
there it's yours to edit; a later catalog update never overwrites your copy.
Stations from the directory aren't "installed" — they're pins on the public map.

## The four schemas

All frontmatter examples below use the same conventions the community repo
enforces. Bad frontmatter is reported at submission time (and, for skills, logged
and skipped by the controller) — it never breaks a running station.

### Skills — `skills/<slug>/SKILL.md`

A between-track segment brief the DJ reads from. Catalog skills are
**prompt-only and data-only**: they carry a brief and metadata, never code (no
`tool.mjs`). The markdown body is the brief.

```markdown
---
name: <slug>
label: Commute check-in          # human label (optional; defaults to the slug)
cooldown: 2h                     # min gap between airings: "90m" | "6h" | "2d" | "45s" | "45" (bare = minutes)
context: clock, time             # optional "right now" fields the segment may mention:
                                 #   date, clock, time, weather, festival, show, listeners
window: any                      # "any" (default) or "commute"
---
Say one short line acknowledging that some listeners are probably in transit
right now. Keep it warm, keep it brief, and skip it when nothing fits.
```

The slug must not shadow a built-in or reserved kind: `link`, `dj-speak`,
`announcement`, `station-id`, `hourly`, `hourly-check`, `album-anniversary`,
`curiosity`, `library-deep-cut`, `news`, `now-playing-dig`, `weather`,
`web-search`. The `context:` allow-list is the same one documented in
[`docs/custom-skills.md`](./custom-skills.md) — leave it off and the segment gets
the default profile (everything except `weather`).

### Personas — `personas/<slug>/PERSONA.md`

A DJ character. The body is the **soul** — the character prose the DJ writes in,
up to 1000 characters. Station-specific bindings (voice, avatar, which skills it
runs) are set by the operator after install, so they aren't part of the catalog
entry.

```markdown
---
name: <slug>
displayName: The Archivist       # on-air name, ≤40 chars (required)
tagline: Liner notes and why this take.   # ≤80 chars (optional)
frequency: quiet                 # silent | quiet | moderate | chatty | aggressive
scriptLength: extended           # one-liner | concise | extended | storyteller
djMode: false                    # true = chattier + transition FX
humour: 3                        # tone dials 0–10 (5 = neutral); also localColour, warmth
language: English                # free-text on-air language, ≤60 chars (optional)
---
A crate-digger who treats every record like a found document. Speaks in liner
notes: who played on it, where it was cut, why this pressing. Never rushed.
```

### Shows — `shows/<slug>/SHOW.md`

A **show template**: a standing brief plus music-steering filters and mode flags.
A show carries only what travels between stations — everything tied to your
particular library and schedule is bound on install (see the next section). The
body is the **topic** brief, up to 1000 characters.

```markdown
---
name: <slug>
displayName: Late Feels          # show name, 1–60 chars (required)
moods: reflective, night         # each from the mood vocab below, max 6 (optional)
genres: shoegaze, dream pop      # free text, ≤64 chars each, max 6 (optional)
eras: 1988-1999                  # comma list of YYYY or YYYY-YYYY windows, years 1900–2100 (optional)
energies: low                    # low | medium | high, max 6 (optional)
filtersStrict: false             # true = hard filter instead of a soft lean
programme: false                 # true = produced-episode mode (intro / feature / outro)
banter: false                    # true = scripted multi-voice breaks (needs guests, added on install)
segmentSkill: library-deep-cut   # optional skill kind to pin the programme feature to
---
A slow midnight drift for the people still awake. Long fades, quiet talk, the
kind of records that only make sense after dark.
```

**Mood vocabulary:** `energetic, calm, reflective, celebratory, romantic,
spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning,
evening, festival, cultural`.
**Energy vocabulary:** `low, medium, high`.

`filtersStrict: false` makes the moods/genres/eras/energies a **soft lean** (they
bias selection); `true` makes them a **hard filter** (tracks outside them are
excluded). `programme` turns the show into a produced episode with an intro, an
hourly feature beat, and an outro; `banter` airs scripted multi-voice breaks and
needs guest co-hosts, which the operator seats on install; `segmentSkill` pins the
programme's feature beat to a specific skill kind.

#### What's portable vs. bound on install

The catalog entry only carries the parts that make sense on any station. When you
install a show, you bind the rest to your own setup:

| Portable (in the SHOW.md) | Bound by the operator on install |
|---|---|
| The topic brief (the body) | The host persona |
| Music filters: `moods`, `genres`, `eras`, `energies`, `filtersStrict` | Guest co-hosts (needed for `banter`) |
| Mode flags: `programme`, `banter`, `segmentSkill` | Theme / styling |
| | Playlist anchors (a Navidrome playlist) |
| | The weekly schedule slot (day + hour) |

So a show template describes *what the show is about and how it should sound and
run* — not *whose voice reads it, what plays, or when it airs*. Those are yours to
wire up.

### Stations — `stations/<slug>.json`

One JSON object per station for the public directory. `name` and `url` are
required; everything else enriches the map pin.

```json
{
  "name": "Klair Radio",
  "url": "https://radio.klair.co",
  "operator": "@perminder-klair",
  "location": "Punjab, India",
  "country": "India",
  "lat": 31.1471,
  "lon": 75.3412,
  "genre": "punjabi",
  "description": "Punjabi all day — an AI DJ picking the tracks and talking between them.",
  "featured": false
}
```

## Security

The catalog is content, not code. **Skills in the catalog are prompt-only and
data-only** — a `SKILL.md` brief plus frontmatter, never a `tool.mjs` data
fetcher. Installing from the Community catalog can never run third-party code on
your box; the worst a bad brief can do is make the DJ say something you'd rather
it didn't, and installs arrive disabled so you read them first. Personas and
shows are likewise prose plus knobs.

The one path that *can* carry code is the **zip export/import** for skills, and
that path is **local and operator-to-operator only** — it never touches the
catalog. A zipped skill may include a `tool.mjs`, so importing one is the same
trust decision as dropping a folder into `state/skills/` by hand: only import a
zip you've read and trust. See
[`docs/custom-skills.md` → Sharing skills](./custom-skills.md#sharing-skills) for
the export/import mechanics and the guard rails around it.
