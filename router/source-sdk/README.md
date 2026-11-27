# @subwave/source-sdk

Types and `defineSource()` for writing a [SUB/WAVE](https://github.com/perminder-klair/subwave) music-source plugin: a module that lets a station play from a music server or library SUB/WAVE doesn't support out of the box.

The full contract (manifest, ops, ids, the context, installing) is the [plugin guide](https://github.com/perminder-klair/subwave/blob/main/docs/music-source-plugins.md). This package is the typed half of it.

```bash
npm install --save-dev @subwave/source-sdk
```

It is a **dev dependency**. A plugin ships as one bundled ES module, and nothing is installed beside it inside the router, so either import types only or let your bundler inline `defineSource` (an identity function, a few bytes).

## TypeScript

```ts
import { defineSource, type Song } from '@subwave/source-sdk';

export default defineSource((ctx) => ({
  async song(id) {
    const res = await ctx.fetch(`${ctx.config.url}/tracks/${id}`);
    const t = await res.json();
    return { id: t.id, title: t.name } satisfies Song;
  },
  // …
}));
```

Bundle it to one `index.mjs` (esbuild: `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=index.mjs`).

## Plain JavaScript

```js
/** @type {import('@subwave/source-sdk').SourceFactory} */
export default (ctx) => ({
  async song(id) { … },
});
```

Your editor type-checks it, and the module ships with no import at all. The [Music folder example](https://github.com/perminder-klair/subwave/tree/main/docs/examples/sources/folder) is written this way.

## What's in it

- `defineSource(factory)`: returns `factory` unchanged, for inference.
- `isVariousArtists(albumArtist)`: the compilation convention, for backends with no compilation flag.
- `SOURCE_API_VERSION`: the plugin API major this package describes. Put it in your manifest's `apiVersion`.
- The types: `SourceManifest`, `ConfigField`, `SourceFactory`, `SourceContext`, `SourcePlugin`, `Song`, `Album`, `Artist`, `Playlist`, `StreamResult`, `CoverArt`, …

`StreamResult` and `SourceContext.fetch` use the web `Response` and `ReadableStream` types, so compile with `lib: ["DOM"]` or `@types/node`.

## Versions

The package's major version is the plugin `apiVersion`. A minor release adds to the contract (a new optional op or field) and a plugin written against an older minor still loads. A major release means the router's contract changed, and a router only loads plugins built for its own `apiVersion`.

The package is built from `router/src/sdk/`, the same files the router type-checks itself against, so the two cannot drift.
