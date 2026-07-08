# audiomuse-import

Import pre-computed track analysis from an [AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI)
instance into SUB/WAVE's `library.db`, so a user who already tagged their library
in AudioMuse doesn't have to run SUB/WAVE's slow LLM tagging + BPM/key pass again.

**Standalone** — imports nothing from the controller. It talks only to AudioMuse
over HTTP and to `state/library.db` over SQLite. Only dependency is
[`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3).

## Why this works (and its limits)

Both systems key every track by the **media-server song id**. When AudioMuse and
SUB/WAVE point at the **same Navidrome**, AudioMuse's `score.item_id` *is*
SUB/WAVE's `tracks.id` (the Subsonic id) — so the join is exact and needs no
Navidrome auth at all. The tool reads AudioMuse's whole library via
`GET /api/sync` and writes matched rows straight into `library.db`.

**Navidrome only.** If AudioMuse was run against Jellyfin / Plex / Emby / LMS, its
ids live in that server's namespace and won't match SUB/WAVE's Subsonic ids. The
tool checks `provider_type` on the first page and refuses if it isn't `navidrome`.

### What transfers

| AudioMuse | → SUB/WAVE `tracks` column | Notes |
| --- | --- | --- |
| `tempo` | `bpm` | direct |
| `key` + `scale` | `musical_key` | converted to Camelot (e.g. A minor → `8A`) |
| `energy` | `energy` | bucketed to `low` / `medium` / `high` |
| `mood_vector` + `other_features` | `moods` (JSON array) | static translation to SUB/WAVE's 17-mood vocab (see `map.mjs`); genre/decade tags don't produce moods |
| top genre tag from `mood_vector` | `genre` | only fills an empty genre |

### What does NOT transfer (still needs `npm run analyze`)

- **CLAP / MusiCNN embeddings** — AudioMuse's are a different model + vector space
  from SUB/WAVE's laion-clap, so they can't drive `searchBySound` or zero-shot
  audio moods. Not imported.
- **Ending/outro, structure, LUFS, beats/bars, vocal ranges** — AudioMuse doesn't
  compute them; SUB/WAVE's transitions depend on them.

So this is a **bootstrap, not a full replacement**: it saves the expensive tagging
+ BPM/key work, then you still run `npm run analyze` (heavy tier for sonic search)
to add the transition/embedding data. The import deliberately leaves
`analysis_version` NULL so `npm run analyze` still selects these tracks — and
stamps `tagger_version` so `npm run tag` treats the imported moods as current and
won't redo them.

## Setup

```bash
cd tools/audiomuse-import
npm install
```

## Usage

```bash
AUDIOMUSE_URL=http://audiomuse:8000 node import.mjs [options]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--audiomuse-url <url>` | `$AUDIOMUSE_URL` | AudioMuse base URL. Required. |
| `--library-db <path>` | `<STATE_DIR>/library.db` or `../../state/library.db` | Target DB. |
| `--overwrite` | off | Overwrite existing `bpm`/`moods`/`key`/`energy`. Default fills only empty fields and never clobbers SUB/WAVE's own tags. |
| `--dry-run` | off | Map and report, write nothing. |
| `--concurrency <n>` | `8` | (Reserved; paging is currently sequential.) |
| `--mood-cutoff <0..1>` | `0.4` | Min AudioMuse tag score to count a mood. |
| `--limit <n>` | — | Stop after N tracks (testing). |

### Examples

```bash
# See what would happen, no writes
AUDIOMUSE_URL=http://audiomuse:8000 node import.mjs --dry-run

# Import, filling only gaps (safe alongside SUB/WAVE's own analyzer/tagger)
AUDIOMUSE_URL=http://audiomuse:8000 node import.mjs

# Let AudioMuse's data win everywhere
AUDIOMUSE_URL=http://audiomuse:8000 node import.mjs --overwrite
```

Run it while the station is idle — `library.db` is shared with the running
controller; SQLite serialises the writes, but avoiding a heavy tagging/analysis
pass at the same time is tidier.

## Notes & safety

- **Requires `library.db` schema ≥ v2** (the migration with `bpm`/`musical_key`).
  If lower, the tool refuses and asks you to boot the controller once to migrate.
  It never runs migrations itself — `controller/src/music/library-db.ts` owns the
  schema; this tool only writes columns it defines.
- **Works on a fresh install.** Matched-but-absent tracks are `INSERT`ed from
  AudioMuse's own title/artist/album, so an empty `library.db` gets populated —
  which is the whole point for "I don't want to tag it all again".
- Tracks AudioMuse has but SUB/WAVE's Navidrome doesn't (different `id`) simply
  never match; the import counts and skips them.

## Testing

```bash
node --test          # pure mapping tests (no db needed)
```

`map.mjs` holds all the pure transforms (tag parsing, Camelot conversion, energy
bucketing, the mood map); `map.test.mjs` pins them.
