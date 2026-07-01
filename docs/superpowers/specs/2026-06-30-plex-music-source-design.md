# Plex Music Source — Design Spec

**Issue:** perminder-klair/subwave#692
**Branch:** `feat/plex-music-source`
**Date:** 2026-06-30

---

## Goal

Add Plex Media Server as a selectable music backend alongside Navidrome. One source is active at a time (selector model). The AI picker, session agent, recency, moods/tags, and all downstream logic stay untouched — only the music-data layer changes.

---

## Owner Decisions (locked, from issue #692)

- **Selector model only** — no merged dual-library. One backend drives the whole station.
- **Source-tagged ids** — Plex ids are `plex:{ratingKey}` so a future "both at once" mode can be added without a rewrite.
- **Last.fm for picker parity** — Plex doesn't proxy Last.fm; extend the existing `lastfm.ts` with the methods Plex needs (`getSimilar`, `getTopTracks`, `getArtistInfo`). Already in scrobbling section in UI — not duplicated.
- **No Plex Pass dependency** — `supportsSonicSimilarity()` returns `false`; picker degrades gracefully.

---

## Plex API (confirmed live against LXC 131 at 192.168.0.158:32400)

### Auth
- `X-Plex-Token` header for JSON data endpoints
- `?X-Plex-Token=` query string for stream and cover URLs (so Liquidsoap's `subhttp:` curl sees them)
- Token lives in `Preferences.xml`; operator pastes it into the admin UI

### Key endpoints

| Purpose | Endpoint |
|---------|----------|
| Connection test (no auth) | `GET /identity` |
| List music libraries | `GET /library/sections` → `type: "artist"` entries |
| All tracks | `GET /library/sections/{key}/all?type=10` |
| Random tracks | `?type=10&sort=random` |
| Recently added | `?type=10&sort=addedAt:desc` |
| Most played | `?type=10&sort=viewCount:desc` |
| Genre filter | `?type=10&genre=Pop/Rock` |
| Artist's albums | `GET /library/metadata/{artistRatingKey}/children` |
| Album tracks | `GET /library/metadata/{albumRatingKey}/children` |
| Search | `GET /search?query=&type=10` |
| Cover art | `{baseUrl}{track.thumb}?X-Plex-Token=` (use `thumb` field directly — contains timestamped path) |
| Stream | `subhttp:{baseUrl}{Part.key}?X-Plex-Token=` |

### Track object → SubWave song shape

```ts
// Plex track (JSON, Accept: application/json)
{
  ratingKey: "3",
  title: "Girls Like You",
  grandparentTitle: "Maroon 5",   // artist
  parentTitle: "Red Pill Blues",  // album
  parentYear: 2017,
  duration: 235568,               // milliseconds
  thumb: "/library/metadata/2/thumb/1782812114",  // album art path
  Genre: [{ tag: "Pop/Rock" }],
  Part: {
    key: "/library/parts/1/1782811927/file.opus",
    file: "/media/music/09 - Girls Like You.opus",
  }
}

// → SubWave Song
{
  id: "plex:3",
  title: "Girls Like You",
  artist: "Maroon 5",
  album: "Red Pill Blues",
  year: 2017,
  genre: "Pop/Rock",
  duration: 235,                  // seconds
  path: "/media/music/09 - Girls Like You.opus",  // for isStationArchive
}
```

---

## Architecture

### New files

#### `controller/src/music/source/types.ts`
The `MusicSource` interface — every backend satisfies it. Pins the song-object contract.

```ts
export interface Song {
  id: string;          // 'plex:{ratingKey}' or bare Navidrome base32
  title: string;
  artist: string;
  album: string;
  year?: number;
  genre?: string;
  duration?: number;   // seconds
  path?: string;       // local path, for isStationArchive guard
  crossSec?: number;   // controller-augmented: adaptive crossfade
  gainDb?: number;     // controller-augmented: loudness normalisation
}

export interface MusicSource {
  ping(): Promise<{ ok: boolean; reason?: string }>;
  isStationArchive(song: Song): boolean;
  search(query: string, opts?: { songCount?: number; songOffset?: number }): Promise<Song[]>;
  getRandomSongs(opts?: { size?: number; genre?: string; fromYear?: number; toYear?: number }): Promise<Song[]>;
  getSongsByGenre(genre: string, opts?: { count?: number }): Promise<Song[]>;
  getGenres(): Promise<{ value: string; songCount: number; albumCount: number }[]>;
  resolveGenreName(name: string): Promise<string | null>;
  resolveArtist(name: string, opts?: { artistCount?: number }): Promise<any | null>;
  getSimilarSongs(id: string, opts?: { count?: number }): Promise<Song[]>;
  supportsSonicSimilarity(): Promise<boolean>;
  getSonicSimilarTracks(id: string, opts?: { count?: number }): Promise<Song[]>;
  getStarred(): Promise<Song[]>;
  getRecentlyAddedAlbums(opts?: { size?: number }): Promise<any[]>;
  getFrequentAlbums(opts?: { size?: number }): Promise<any[]>;
  getArtistInfo(id: string, opts?: { count?: number }): Promise<any | null>;
  getTopSongs(artistName: string, opts?: { count?: number }): Promise<Song[]>;
  getRecentSongsByArtist(artistName: string, opts?: { albums?: number; count?: number }): Promise<Song[]>;
  getAlbum(id: string): Promise<Song[]>;
  getSong(id: string): Promise<Song | null>;
  getArtist(id: string): Promise<any | null>;
  searchArtists(query: string, opts?: { artistCount?: number }): Promise<any[]>;
  getArtistLastfmTags(id: string, opts?: { count?: number }): Promise<string[]>;
  getLyrics(songId: string): Promise<string>;
  iterateAllSongs(): AsyncGenerator<Song>;
  getPlaylists(): Promise<any[]>;
  getPlaylist(id: string): Promise<Song[]>;
  getCoverArtUrl(id: string, size?: number): string;
  getStreamUrl(songId: string): string;
  getRawStreamUrl(songId: string): string;
  getLocalPath(song: Song): string | null;
  getPlayableUri(song: Song): string;
  getAnnotatedUri(song: Song, opts?: { maxDurationSec?: number | null }): string;
}
```

#### `controller/src/music/source/index.ts`
Router — reads `settings.music.source`, returns the active backend. Memoized by config signature (same pattern as `llm/internal/provider/registry.ts`).

```ts
import * as navidrome from '../subsonic.js';
import * as plex from '../plex.js';
import * as settings from '../../settings.js';

let _cached: { source: string; instance: MusicSource } | null = null;

export function getSource(): MusicSource {
  const source = settings.get().music?.source || 'navidrome';
  if (_cached?.source === source) return _cached.instance;
  const instance = source === 'plex' ? plex : navidrome;
  _cached = { source, instance };
  return instance;
}

export function invalidateSourceCache() { _cached = null; }
```

#### `controller/src/music/plex.ts`
Full Plex backend satisfying `MusicSource`. Key implementation notes:

- Reads `config.plex.url` and `config.plex.token`
- All JSON requests: `Accept: application/json` header + `X-Plex-Token` header
- Stream/cover URLs: token in query string
- Music section key auto-discovered on first call via `/library/sections` (cached, reset on `invalidateSourceCache()`)
- `getSimilarSongs` / `getTopSongs` / `getArtistInfo` → route through extended `lastfm.ts` + Plex search resolution
- `supportsSonicSimilarity()` → `false` always
- `getLyrics()` → `''` (Plex has lyrics in newer versions but not required)
- `getLocalPath()` → `null` (Plex is always remote)
- `isStationArchive()` → checks `song.path` for `archive/` prefix, same logic as Navidrome impl
- `getAnnotatedUri()` → shared helper extracted from `subsonic.ts`, field name stays `subsonic_id` (value is `plex:3`), adds `source="plex"` annotation

#### Extended `controller/src/music/lastfm.ts`
Add three methods needed by the Plex backend (Navidrome proxies these via its Subsonic API; Plex doesn't):

```ts
// New exports:
export async function getSimilarArtists(artist: string, opts?: { count?: number }): Promise<string[]>
export async function getTopTracks(artist: string, opts?: { count?: number }): Promise<{ title: string; artist: string }[]>
export async function getArtistInfo(artist: string): Promise<{ bio?: string; tags?: string[] } | null>
```

`plex.ts` calls these and resolves names back to Plex tracks via `search()`.

---

### Modified files

#### `controller/src/config.ts`
Add Plex block:
```ts
plex: {
  url: process.env.PLEX_URL || '',
  token: process.env.PLEX_TOKEN || '',
},
```

#### `controller/src/settings.ts`
```ts
export const MUSIC_SOURCES = ['navidrome', 'plex'] as const;

// In DEFAULTS:
music: { source: 'navidrome' as string },

// In load():
music: {
  source: MUSIC_SOURCES.includes(stored.music?.source) ? stored.music.source : 'navidrome',
},

// In update():
if (patch.music?.source !== undefined) {
  if (!MUSIC_SOURCES.includes(patch.music.source)) throw new Error('...');
  next.music.source = patch.music.source;
  invalidateSourceCache();  // imported from music/source/index.ts
}
```

#### 10 call sites → import from `music/source/index.ts`
Files: `doctor.ts`, `broadcast/queue.ts`, `broadcast/scheduler.ts`, `llm/internal/tools/segment-tools.ts`, `llm/internal/tools/picker-tools.ts`, `routes/dj.ts`, `routes/debug.ts`, `routes/public.ts`, `routes/library.ts`, `routes/request.ts`

Change: `import * as subsonic from '../music/subsonic.js'` → `import { getSource } from '../music/source/index.js'` + use `getSource()` at call time (not module load time, so source switches take effect immediately).

#### `routes/public.ts` — cover proxy
```ts
// Updated id validation — allow source-prefixed ids:
const ID_RE = /^[\w:-]{1,80}$/;

// Route by prefix:
const coverUrl = id.startsWith('plex:')
  ? plex.getCoverArtUrl(id, 512)
  : subsonic.getCoverArtUrl(id, 512);
const r = await fetch(coverUrl, { signal: ctrl.signal });
```

#### `doctor.ts`
Replace `subsonic.ping()` with `getSource().ping()`. Label shows active source name.

#### `setup/config.ts`
```ts
export interface SetupConfig {
  navidrome?: { url?: string; user?: string; pass?: string };
  plex?: { url?: string; token?: string };  // ADD
  setupCompletedAt?: string;
}
```

#### `setup/firstRun.ts` — `needsSetup`
`needsSetup = false` when EITHER Navidrome creds OR Plex URL+token are configured:
```ts
const hasNavidrome = !!(nv.url && nv.user && nv.pass) || !!(env.NAVIDROME_URL && env.NAVIDROME_USER && env.NAVIDROME_PASS);
const hasPlex = !!(setupCfg.plex?.url && setupCfg.plex?.token) || !!(process.env.PLEX_URL && process.env.PLEX_TOKEN);
needsSetup = !(hasNavidrome || hasPlex);
```

#### `routes/onboarding.ts`
Add `POST /onboarding/test-plex` — hits `/identity` with `X-Plex-Token`, returns `{ ok, version, machineIdentifier }`.
Add Plex save path in `POST /onboarding/save` — saves to `setup-config.json` and patches `config.plex.*` live.

---

## Settings UI — Music Source Section

### New section in `web/components/admin/SettingsPanel.tsx`

Positioned after the existing library/Navidrome fields. Follows existing section pattern exactly:

```
┌─────────────────────────────────────────┐
│ Music source                            │
│                                         │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │  Navidrome   │  │      Plex       │  │
│  │  (selected)  │  │                 │  │
│  └──────────────┘  └─────────────────┘  │
│                                         │
│  [Navidrome fields — shown when active] │
│  Server URL ______________________      │
│  Username   ______________________      │
│  Password   ______________________ 👁   │
│                                         │
│  [Plex fields — shown when active]      │
│  Server URL ______________________      │
│  X-Plex-Token __________________ 👁    │
│  field-hint: Found in Plex → Settings   │
│  → Plex Media Server → General →        │
│  "X-Plex-Token" or Preferences.xml     │
│                                         │
│  [ Test connection ]  [ Save ]          │
└─────────────────────────────────────────┘
```

- Source toggle: `Seg` (segmented control) with `Navidrome` | `Plex` — same component used for cloud TTS provider selector
- Navidrome URL/user/pass: already exist in onboarding only; replicated here, save via `saveSetupConfig` + live `config.navidrome.*` patch
- Plex URL: save via `saveSetupConfig({ plex: { url } })` + live `config.plex.url` patch
- Plex token: save via `POST /settings/secrets` with `{ PLEX_TOKEN: value }` — same secrets path used by LLM/TTS API keys
- Test button: `POST /onboarding/test-plex` (Plex) or existing `POST /onboarding/test-navidrome` (Navidrome)
- `music.source` setting: saved via `POST /settings` with `{ music: { source: 'plex' | 'navidrome' } }`

### `web/` types changes
- `SettingsResponse` — add `music?: { source: string }` to `values`
- Add `PlexSection` component (or inline in `SettingsPanel.tsx` following existing pattern)
- Add `music` to SECTIONS nav array: `{ id: 'music', label: 'Music', hint: 'source · library', icon: Music2 }`

---

## Unit Test

Pin the Plex song-object normalizer (owner's verification requirement):

```ts
// controller/src/music/plex.test.ts
import { normalizePlexTrack } from './plex.js';

test('normalizes Plex track to SubWave Song shape', () => {
  const plexTrack = {
    ratingKey: "3",
    title: "Girls Like You",
    grandparentTitle: "Maroon 5",
    parentTitle: "Red Pill Blues",
    parentYear: 2017,
    duration: 235568,
    thumb: "/library/metadata/2/thumb/1782812114",
    Genre: [{ tag: "Pop/Rock" }],
    Part: [{ file: "/media/music/09 - Girls Like You.opus", key: "/library/parts/1/1782811927/file.opus" }],
  };
  const song = normalizePlexTrack(plexTrack);
  expect(song.id).toBe('plex:3');
  expect(song.title).toBe('Girls Like You');
  expect(song.artist).toBe('Maroon 5');
  expect(song.album).toBe('Red Pill Blues');
  expect(song.year).toBe(2017);
  expect(song.genre).toBe('Pop/Rock');
  expect(song.duration).toBe(235);
  expect(song.path).toBe('/media/music/09 - Girls Like You.opus');
});
```

---

## Explicitly Out of Scope

- Merged dual-library (owner decided: selector only)
- Plex Pass sonic analysis
- Lyrics via Plex
- Plex playlist sync to Liquidsoap auto.m3u (Navidrome-only feature for now)
- Global Last.fm section in UI (already in scrobbling)

---

## Verification (from owner's issue)

1. `cd controller && npm run lint` — 0 errors
2. `cd web && npm run lint` — 0 errors
3. Unit test for `normalizePlexTrack` passes
4. Switch `settings.music.source = 'navidrome'` → existing station unchanged (regression guard)
5. Switch to `plex` → `/api/health` on-air, `/now-playing` advances, `/cover/plex:3` resolves Plex art, `next.txt` carries valid `annotate:…:subhttp:` Plex URL
6. Listener request + auto-playlist refresh against Plex exercises Last.fm-extended discovery path
