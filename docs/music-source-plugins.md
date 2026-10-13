# Writing a music-source plugin

SUB/WAVE plays from Navidrome directly, or from anything the **music router** can reach: Jellyfin, Plex, Navidrome, a demo library, and any plugin you install. A plugin is one folder with a manifest and a JavaScript module. This page is the whole contract.

A complete, working example lives in [`docs/examples/sources/folder`](./examples/sources/folder) — a music folder on disk, in about 200 lines with no dependencies. Read it alongside this page.

## What you build

```
my-source/
  subwave-source.json   # the manifest
  index.mjs             # export default (ctx) => ({ ...ops })
```

Install it by copying the folder to `state/router/plugins/my-source/` and pressing **Rescan plugins** in Admin → Settings → Music source. It then appears in the source picker, with a settings form drawn from your manifest.

> **Plugins are code.** They run inside the router with network access. Install only plugins you have read and trust. The router only sees `state/router/`, not the rest of the station's state, but a plugin can still reach anything the router can reach on the network.

## The manifest

```json
{
  "name": "emby",
  "label": "Emby",
  "description": "Stream an Emby music library.",
  "version": "1.0.0",
  "apiVersion": 1,
  "idPrefix": "emby",
  "entry": "index.mjs",
  "homepage": "https://emby.media",
  "config": [
    { "key": "url", "label": "Server URL", "type": "url", "required": true, "env": "EMBY_URL", "placeholder": "http://emby:8096", "affectsIds": true },
    { "key": "apiKey", "label": "API key", "type": "secret", "required": true, "env": "EMBY_API_KEY" },
    { "key": "user", "label": "User", "type": "string", "help": "Whose favourites to use.", "affectsIds": false }
  ]
}
```

| Field | Rule |
| --- | --- |
| `name` | `^[a-z][a-z0-9-]{1,31}$`. Unique; a plugin cannot take a built-in's name (`mock`, `navidrome`, `jellyfin`, `plex`). |
| `apiVersion` | `1`. The router refuses a plugin written for an API version it does not implement, and says so in the admin UI. |
| `idPrefix` | `^[a-z][a-z0-9]{1,5}$`. Unique. Your ids are published as `<idPrefix>-<native id>`. |
| `entry` | Relative path inside the folder. Defaults to `index.mjs`. |
| `config[]` | The settings form. `type` is `url`, `string`, `secret`, `number`, `boolean` or `select` (`select` needs `options: [{ value, label }]`). `secret` values are write-only in the UI. `env` names a variable that overrides the field and locks it in the form. Give the server address the `url` type: a stored secret is reused only while every `url` field is unchanged, so it is never sent to a new host. `affectsIds: true` marks a setting that changes the ids you publish (a server address, a library section); `affectsIds: false` one that does not (a display toggle). Changing a marked setting makes the station re-link its library (tags, likes, the blocklist) by metadata; mark at least one field either way, or every non-secret field counts. |

## The module

```js
export default (ctx) => ({
  async song(id) { … },
  // …
});
```

The default export is a factory the router calls with a context whenever the operator's selection is (re)applied. If you want types, `import { defineSource } from '@subwave/source-sdk'` and wrap the factory (`router/src/sdk/` is that package). A plugin ships as **one bundled ES module**: nothing is installed inside the container, so either use only Node built-ins (`node:fs`, `node:crypto`, `fetch`) or bundle your dependencies (esbuild, rollup). A backend that needs another language belongs in its own service that your plugin talks to over HTTP.

### The context

| `ctx.` | |
| --- | --- |
| `config` | The form's values: environment overrides applied, manifest defaults filled, required fields guaranteed present. |
| `fetch` | `fetch` with a 20s default timeout for the server to start answering (the headers). The body is not on that clock, so a `{ response }` you return from `stream()` can take as long as the track does. Pass your own `signal` to change it. |
| `log` | `info` / `warn` / `error`, prefixed with your plugin name in the router log. |
| `dataDir` | A writable folder only you use (`state/router/data/<name>`). |

Keep the factory cheap: no network calls in it. Build state lazily on first use, and implement `close()` if you start timers.

### Two rules that make plugins simple

1. **Use your backend's own ids.** Return them as they are; the router namespaces everything you emit and strips the prefix from everything it hands you. Ids must be **stable across restarts** — the station stores them in its library database, likes, blocklist and stem cache. Derive them from the backend (or, like the folder example, from something on disk), never generate them per run.
2. **Return loose objects.** Only `id` and the name/title are required. Leave out anything you do not know — the router fills neutral defaults (year 0, no genres, no ReplayGain). Never invent a measurement: a `replayGain` of 0 dB reads as "measured, needs no change".

### Required ops

| Op | Returns |
| --- | --- |
| `song(id)` | `Song` or `undefined` |
| `album(id)` | `{ album, songs }` or `undefined` |
| `artist(id)` | `{ artist, albums }` or `undefined` |
| `genres()` | `[{ name, songCount?, albumCount? }]` |
| `albumList(type, size, offset)` | `Album[]`; `type` is `alphabeticalByName`, `newest`, `frequent` or `random`. The library walk pages this to the end, so it must page correctly. |
| `songsByGenre(genre, count, offset)` | `Song[]` |
| `randomSongs(size, { genre?, fromYear?, toYear? })` | `Song[]` — the station's fallback; never return an empty list from a non-empty library. |
| `search(query, { artistCount, albumCount, songCount })` | `{ artists, albums, songs }`; an empty query may return everything. |
| `stream(id, { range })` | see below |
| `coverArt(id, size)` | `{ contentType, data }` or `{ url, headers? }`, or `undefined`. Asked with a song id **or** an album id. |

Return `undefined` for an id that does not exist. **Throw** for real failures (server down, bad credentials) — the router reports a throw as *unreachable*, and a wrong password must not look like an empty library.

### Streaming

`stream()` says where the bytes are; the router does the HTTP:

```js
return { url: 'https://backend/file/123', headers: { Authorization: '…' } }; // the router fetches it, forwarding Range
return { response };                                                         // a fetch() Response you already made
return { body, status: 206, headers: { 'content-type': 'audio/flac', 'content-length': '…', 'content-range': '…' } };
```

`body` may be a web `ReadableStream`, any async iterable of bytes (a Node file stream works), or a `Uint8Array`. When a client hangs up — including before the first byte — the router cancels a `ReadableStream` and destroys a Node stream. A bare async generator that has not started never runs its `finally`, so open files and connections inside the generator body, or hand over a stream. Send the file's real content type: the router **refuses** JSON, XML, HTML and text bodies, because the station's downloaders write whatever arrives to disk. Honour `range` when you can; Liquidsoap downloads whole files, but other clients seek.

### Optional ops

Leave any of these out and the station degrades instead of failing — the admin UI shows which capabilities a source has.

| Op | Gives the station |
| --- | --- |
| `artists()` | the artist list (episode shows, artist spotlights) |
| `artistInfo(id, count)` | bios, similar artists, tags |
| `similarSongs(id, count)` | the "more like this" picker signal; `id` may be a song or an artist |
| `topSongs(artistName, count)` | an artist's most-played tracks |
| `lyrics(id)` | `{ lines }`, `null` for "no lyrics", `undefined` for "no such song" |
| `starred()` / `starredSongs()` / `star(ids)` / `unstar(ids)` | favourites both ways |
| `playlists()` / `playlist(id)` / `createPlaylist` / `overwritePlaylist` / `updatePlaylist` / `deletePlaylist` | playlists both ways |
| `scrobble(id, { submission, time })` | play counts on your backend |
| `scanStatus()` | `{ scanning }` — the station holds library pruning while your backend rescans |
| `stats()` | library counts, and the router's health probe |
| `capabilities.sonicSimilarity` | advertise the OpenSubsonic `sonicSimilarity` extension (served by `similarSongs`) |

## Test it

The conformance kit runs the contract the station relies on, through the router's own enforcement layer:

```bash
npm --prefix router install
npm --prefix router run conformance -- /path/to/my-source --config url=http://emby:8096 --config apiKey=…
```

It checks the manifest, every required op, that ids are publishable and stable across two independent instances, that `stream` returns at least 4 KiB of non-text audio, Range handling, cover art, and each optional op you implement. Add `--allow-writes` to also exercise stars and a scratch playlist (it deletes what it creates). It exits non-zero on any failure, so it can gate your plugin's own CI.

Then, in the admin UI: install, **Rescan plugins**, pick it, **Test connection**, save. The Library health card shows its counts and capabilities, and the Doctor reports it under *Music library*.

## Versioning

Bump your `version` freely. `apiVersion` changes only when the router's contract does; the router lists incompatible plugins with the reason rather than loading them.
