# Music sources (beyond Navidrome)

> **Status: implemented** (Navidrome/Subsonic, Jamendo, Jellyfin, local folder).
> This document sketched a *source provider* abstraction so SUB/WAVE can play
> music from sources other than a self-hosted Navidrome. The `MusicSource` seam
> and the three new library providers shipped; **yt-dlp is deferred** (its
> generative-picker path + `ytdl:` protocol remain out of scope). The original
> sketch is kept below for context — see **"What actually shipped"** at the bottom
> for where the build deviated from it.

## Why this exists

SUB/WAVE's whole model is: **the server holds the actual audio.** The controller
writes a track URI to `next.txt`, Liquidsoap decodes it to crossfade, duck under the
DJ voice, mix in jingles, and re-encode to one shared Icecast stream everyone hears.
Anything that can't hand Liquidsoap decodable audio can't be a source.

That immediately rules out **Spotify** — on two independent grounds:

- **Technical:** Spotify exposes no raw/decodable stream. The Web Playback SDK and
  `librespot` only render audio inside an authenticated client tied to one account;
  you can't pull PCM out to re-broadcast to N anonymous Icecast listeners.
- **Legal:** re-streaming Spotify audio to a public Icecast mount is a flat
  ToS/DRM/licensing violation. It isn't a "needs an API key" gap — it's the product
  they sell.

Spotify could still serve as a **discovery/metadata** input ("what to play next"),
but the audio would have to come from one of the real sources below. That's out of
scope for this document.

## The core problem

There is **no source abstraction today.** `subsonic` is imported directly at ~40
call sites across the controller. Everything is welded to two implicit contracts:

1. **The song object** — `{ id, title, artist, album?, year?, genre?, path? }`
   plus analysis fields (`bpm`, `musicalKey`, `introMs`, `loudnessLufs`) and
   transient fields (`crossSec`, `gainDb`, `_source`, `_similarity`) added later.
2. **The annotated URI** — `queue.drainToLiquidsoap()`
   (`controller/src/broadcast/queue.ts:415`) calls `subsonic.getAnnotatedUri(track)`
   to produce the single thing written to `next.txt`:

   ```
   annotate:title="…",artist="…",album="…",subsonic_id="<id>",year="…",genre="…",liq_cross_duration="…",liq_amplify="… dB":<playable_uri>
   ```

   where `<playable_uri>` is a local file path (if the music volume is shared) or a
   `subhttp:`-wrapped stream URL (curl, to dodge Cloudflare 522s on the origin).

Anything we add must satisfy those two contracts, plus feed the discovery surface
(search / similar / genre / random / album / playlist) the picker and agent tools
call.

### Where `subsonic` is coupled in

| File | Coupling |
|---|---|
| `broadcast/queue.ts` | `getAnnotatedUri()` — the single writer of `next.txt` |
| `music/picker.ts` | ~15 calls across `buildCandidates()` (similar, genre, random, albums, playlists, top songs, sonic-similarity…) |
| `llm/internal/tools/picker-tools.ts` | ~13 discovery tools wrapping subsonic calls |
| `routes/request.ts` | ~13 calls across the request-resolution cascade |
| `routes/public.ts` | `getCoverArtUrl()` for the `/cover/:id` proxy |
| `config.ts` | hard-coded `navidrome: { url, user, password, … }` |
| `setup/config.ts` | `setup-config.json` only models `navidrome` creds |
| `settings.ts` | `LLM_PROVIDERS` / `TTS_ENGINES` exist; **no music-source setting** |

## The honest split: two provider shapes

The sources we want don't fit one mold — they fall into two:

**Library providers** (have a browseable catalog → can fill the picker's candidate
pool):

- **Subsonic family** — Navidrome, Airsonic-Advanced, Gonic, Ampache, LMS.
  *Already work today* with just URL/cred changes, because `music/subsonic.ts`
  speaks the **Subsonic API**, not Navidrome specifically.
- **Jellyfin** — its own API, but nearly as rich: search, genres, artists, albums,
  playlists, **InstantMix** (≈ similar), recently-added, frequently-played, cover
  art, token-auth streaming. ~90% of the surface maps cleanly.
- **Jamendo** — remote Creative-Commons catalog. Search, tags-as-genres, artists,
  albums, "radios" ≈ similar, public MP3 URLs (no auth, directly playable). Partial
  surface (no personal playlists/starred), but an excellent zero-self-host
  onboarding path. The Jamendo bulk-pull tool already exists.
- **Local folder / M3U** — the thinnest. No similar / Last.fm / playlists.
  Discovery = random + genre-from-ID3 + filename search, leaning on the
  locally-built embedding library (`music/library.*`) for "more like this."

**Resolver providers** (no catalog at all → search-driven only):

- **yt-dlp** (YouTube Music / SoundCloud) — *not a library.* It **resolves** a
  query to a media URL. There's no pool to sample, no "starred", no "recently
  added". The pool-picker model in `buildCandidates()` does not apply.

This split is the key design decision: **one interface, capability-gated**, plus a
second control-flow path for the catalog-less (resolver) sources.

## Proposed abstraction

A `MusicSource` interface with a **small required core** plus **optional
capabilities**, declared via flags so the picker and agent degrade gracefully
instead of erroring when a capability is absent.

```ts
interface MusicSource {
  key: string                       // 'navidrome' | 'jellyfin' | 'jamendo' | 'local' | 'ytdl'
  capabilities: {
    pool: boolean                   // can fill a candidate pool (false for ytdl)
    similar: boolean
    genre: boolean
    playlists: boolean
    starred: boolean
    recentlyAdded: boolean
    frequent: boolean
    artistGraph: boolean            // Last.fm-style top-songs / similar-artist
    sonicSimilarity: boolean
    lyrics: boolean
  }

  // --- required core (every provider) ---
  search(query, opts): Promise<Song[]>
  getRandomSongs(opts): Promise<Song[]>
  getAnnotatedUri(song): string     // the load-bearing contract
  getCoverArtUrl(id, size): string | null
  isStationArchive(song): boolean

  // --- optional; presence mirrors `capabilities` ---
  getSimilarSongs?, getSongsByGenre?, resolveGenreName?,
  getAlbum?, getPlaylists?, getPlaylist?, getStarred?,
  getRecentlyAddedAlbums?, getFrequentAlbums?,
  resolveArtist?, getArtist?, getTopSongs?,
  getRecentSongsByArtist?, supportsSonicSimilarity?,
  getSonicSimilarTracks?, getLyrics?
}
```

Then:

- **`picker.buildCandidates()`** checks `source.capabilities.*` before pulling each
  of its 7 sub-sources (it already tolerates empty results, so this is a light
  change).
- **`picker-tools.buildPickerTools()`** registers only the tools the active source
  supports.
- **`queue.drainToLiquidsoap()`** calls `source.getAnnotatedUri()` instead of
  `subsonic.getAnnotatedUri()`.
- **`/cover/:id`** dispatches by id prefix (see below).

### Two cross-cutting details

**1. ID namespacing.** Today `song.id` is a Subsonic id and `/cover/:id` calls
`subsonic.getCoverArtUrl(id)` directly. With multiple providers, prefix ids:
`nd:abc123`, `jf:xyz`, `jam:123`, `ytdl:VIDEOID`. `/cover/:id` parses the prefix and
routes to the right provider's cover function. The annotated URI keeps carrying it as
`subsonic_id` (just an annotation key `radio.liq`'s `on_metadata` reads — no need to
touch the `.liq`).

**2. Streaming per provider:**

- Subsonic / Jellyfin behind Cloudflare → keep the existing `subhttp:` curl
  protocol.
- Jamendo / local → plain URL / file path, directly playable.
- **yt-dlp** → mirror the existing `subhttp:` pattern with a new `ytdl:` Liquidsoap
  protocol that shells out to `yt-dlp -g` (or resolve the direct URL at drain time —
  playback happens within seconds, so the googlevideo URL expiry is a non-issue).
  Same shape as the curl trick already in `radio.liq`.

### The yt-dlp control flow (the interesting one)

Since there's no pool, yt-dlp can't use `pickViaPool()`. Instead it slots into a
**generative-picker** path: the LLM proposes a concrete next track (artist + title)
from context + recent plays, then the source resolves it via yt-dlp search. This is
basically the **DJ-agent tool-loop** that already exists (`broadcast/dj-agent.ts`) —
`searchLibrary` maps to a yt-dlp search tool; "similar" becomes "LLM names adjacent
artists, re-search". So yt-dlp rides on the agent path rather than `picker.ts`.

## Per-source feasibility at a glance

| Source | Shape | Effort | Notes |
|---|---|---|---|
| Other Subsonic servers | library | **~0** | Already works; needs docs + onboarding label |
| Jellyfin | library | medium | New client; ~90% surface via native API |
| Jamendo | library | medium | Partial surface; public MP3s, no auth |
| Local folder / M3U | library (thin) | medium | Leans on the embedding library for "similar" |
| yt-dlp | resolver | medium-high | Generative-picker path + `ytdl:` protocol; **legal caveat** |

**Legal caveat on yt-dlp:** technically feasible, but re-streaming YouTube /
SoundCloud audio to a public Icecast mount is against their ToS and licensing. Fine
for private / personal use; it should be gated behind an explicit "I understand" flag
and kept out of the default onboarding — a power-user opt-in.

## Recommended phased plan

1. **Phase 0 — free win.** Verify and document that other Subsonic servers already
   work; relabel onboarding "Navidrome" → "Subsonic-compatible server (Navidrome,
   Airsonic, Gonic…)". Add a `source` setting to `settings.ts` (currently only
   LLM/TTS providers exist).
2. **Phase 1 — extract the interface.** Define `MusicSource`, wrap the current code
   as the `navidrome` / `subsonic` provider, and route all ~40 call sites through a
   `getSource()` accessor. Pure refactor, no behaviour change — the load-bearing,
   riskiest step, so it lands on its own.
3. **Phase 2 — Jamendo provider** (best zero-self-host payoff; reuses the existing
   bulk-pull work).
4. **Phase 3 — Jellyfin provider** (richest non-Subsonic library).
5. **Phase 4 — local folder** (simplest "I just have files").
6. **Phase 5 — yt-dlp** (generative-picker path + `ytdl:` protocol, behind an opt-in
   flag).

Phase 1 is the real work; everything after is additive.

## Interface contracts a provider must satisfy

### Contract 1 — song object

```ts
interface ProviderSong {
  id: string            // unique within this provider (namespaced on the way out)
  title: string
  artist: string
  album?: string
  year?: number
  genre?: string
  path?: string         // for the isStationArchive() pattern check
  // analysis (added by queue.ts / library):
  bpm?: number
  musicalKey?: string
  introMs?: number
  loudnessLufs?: number
  // transient (added by queue.ts / picker):
  crossSec?: number     // DJ-mode crossfade
  gainDb?: number       // loudness gain
  _source?: string      // picker source label
  _similarity?: number  // KNN similarity score
}
```

### Contract 2 — annotated URI

`getAnnotatedUri(song)` must return a Liquidsoap-playable URI with metadata
embedded:

```
annotate:title="…",artist="…",album="…",subsonic_id="<song.id>",year="…",genre="…",liq_cross_duration="…",liq_amplify="… dB":<playable_uri>
```

- `subsonic_id` carries the (namespaced) `song.id`; `on_metadata` uses it for
  `/cover/:id`.
- `<playable_uri>` is a local file path, a plain HTTP stream URL (auth baked in), or
  a `subhttp:` / `ytdl:` wrapped URL.

### Contract 3 — discovery surface (capability-gated)

`search`, `getRandomSongs`, `getAnnotatedUri`, `getCoverArtUrl`, `isStationArchive`
are **required**. Everything else (`getSimilarSongs`, `getSongsByGenre`,
`resolveGenreName`, `getAlbum`, `getPlaylists`, `getPlaylist`, `getStarred`,
`getRecentlyAddedAlbums`, `getFrequentAlbums`, `resolveArtist`, `getArtist`,
`getTopSongs`, `getRecentSongsByArtist`, `supportsSonicSimilarity`,
`getSonicSimilarTracks`, `getLyrics`) is **optional** and gated by the matching
capability flag.

## What actually shipped

The build followed the sketch above, with these deliberate deviations:

- **Single active source**, not multi-source. One provider is selected in
  `settings.source.provider` (env `MUSIC_SOURCE` wins). Ids are namespaced at the
  boundary (`nd:`/`jf:`/`jam:`/`local:`) so multi-source remains an additive
  follow-up, but the picker does **not** merge across providers.
- **yt-dlp deferred.** The generative-picker path and `ytdl:` protocol weren't
  built. Shipped: Navidrome/Subsonic (`navidrome`, with the `subsonic` alias),
  Jamendo, Jellyfin, local folder.
- **Methods are non-optional** on the `MusicSource` interface. Every provider
  implements the full surface; unsupported capabilities return empty/null/false
  (via a shared `emptyDiscovery` default) and the `capabilities` flags tell the
  picker/agent whether a call is worth making. This keeps the ~80 call sites clean
  (no `?.`).
- **The coupling was wider than the table claimed** — ~80 `subsonic.*` calls
  across **14** files (the table listed 8). All route through `getSource()` now.
- **`Song` gained the fields the sketch missed**: `path`, `albumId`, `coverArt`,
  `duration`; transient `crossSec`/`gainDb`/`_source`/`_similarity` are stamped by
  the queue/picker after the provider returns.
- **Enrichment was decoupled from the provider** (the dependency the sketch
  skipped): `music/enrichment/lastfm.ts` fetches Last.fm crowd tags / similar by
  **artist name** directly (reusing the scrobble key), and
  `music/enrichment/lyrics.ts` falls back to LRCLIB — so Jamendo / Jellyfin /
  local get rich embeddings, not just Navidrome. The picker also backfills
  "similar" from Last.fm for sources with no native graph (local).
- **Code layout**: the interface + `Song` + id helpers + annotate builder +
  `sourceConfig()` live in `music/source-kit.ts`; `music/source.ts` is the
  registry/accessor and re-exports the kit; providers live under
  `music/sources/*.ts`.

### Per-source capabilities as built

| Source | pool | similar | genre | playlists | starred | recent | frequent | artistGraph | sonic | lyrics | walk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| navidrome | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓¹ | ✓ | ✓ |
| jamendo | ✓ | ✓ | ✓ | – | – | ✓ | ✓ | ✓ | – | –² | – |
| jellyfin | ✓ | ✓ | ✓ | ✓ | ✓³ | ✓ | ✓³ | ✓ | – | ✓ | ✓ |
| local | ✓ | –⁴ | ✓ | – | – | ✓ | – | ✓ | – | –² | ✓ |

¹ probed per-server (OpenSubsonic extension). ² lyrics via the LRCLIB enricher.
³ needs a Jellyfin user id. ⁴ similar comes from the embedding library + the
Last.fm picker backfill.

### Limitations (v1)

- Jamendo cover art relies on an in-memory URL cache (populated as tracks flow
  through); a cold restart can miss covers for tracks restored from the persisted
  queue until they're seen again.
- Local folder serves **no cover art** (embedded-art extraction isn't wired) and
  skips acoustic bpm/key analysis (the analyzer fetches over HTTP, not file
  paths); text embeddings still build.
- Switching providers orphans the embedding library (keyed by provider ids) — a
  different source re-tags from scratch. No cross-provider id migration.
