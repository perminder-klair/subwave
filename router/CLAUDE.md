# router/ — the SUB/WAVE music router

Serves the Subsonic dialect `controller/src/music/subsonic.ts` speaks, answered by music-source plugins. **That client is the spec**: when you change a response shape, check what the controller reads, and run `controller/scripts/router-contract.test.ts`. Full design: [`../docs/internals/music-sources.md`](../docs/internals/music-sources.md); plugin contract: [`../docs/music-source-plugins.md`](../docs/music-source-plugins.md).

## Commands

```bash
npm test          # scripts/*.test.ts via node --test (tsx), serial
npm test -- http  # filter by file name
npm run lint      # tsc --noEmit — CI's merge gate for this package
npm run conformance -- <plugin-dir> [--config k=v] [--builtin] [--allow-writes]
```

ESM, `module: NodeNext` (relative imports end in `.js`), `verbatimModuleSyntax` (type-only imports say `import type`). `tsx` runs the source; there is no build step, and runtime deps are only `express`, `zod`, `tsx`.

## Layout

- `src/sdk/` — the plugin contract. Imports nothing from the rest of the router; it is publishable as its own package. Changing it is changing the plugin API: bump `SOURCE_API_VERSION` only for a breaking change, and update `docs/music-source-plugins.md`.
- `src/host/` — everything the router enforces around a plugin: `ids.ts`, `normalize.ts`, `media.ts`, `wrap.ts`, `composite.ts`, `loader.ts`, `manifest.ts`, `registry.ts`, `health.ts`.
- `src/subsonic/` — auth, envelope, one handler per endpoint.
- `src/internal/routes.ts` — the controller's API; its shapes are mirrored by `controller/src/schemas/music-source.ts`. Change both together.
- `src/sources/<name>/` — built-ins, each a `subwave-source.json` + `index.ts`, loaded exactly like an installed plugin. A folder starting with `_` is skipped.

## Rules

- **Plugins never publish ids.** They return native ids; `host/ids.ts` namespaces them. Every published id must fit the controller's `/cover/:id` guard (`^[\w-]{1,64}$`), contain no `/`, and stay out of the shapes `controller/src/music/id-canonical.ts` rewrites — `scripts/ids.test.ts` pins all three.
- **Ids are stable across restarts** for every source. The mock builds its library from a fixed PRNG seed: any change to the *sequence* of `rand()` calls in `sources/mock/library.ts` re-rolls every id after it. Append, or accept and say that all ids change.
- **Binary endpoints never answer an error with 200.** Unknown id → 404, backend failure → 500/502 (`BINARY_ENDPOINTS` in `subsonic/handlers.ts`). Liquidsoap and the analyzer write whatever a 200 carries to disk.
- **The media guard stays.** `host/media.ts` refuses a JSON/XML/HTML/text body where audio or an image was expected, whoever produced it.
- **Resolve `getSource()` once per request** and pass the instance down; a swap can happen between awaits.
- **A selection is built whole before it is swapped in** (`registry.apply`). A failure keeps the running source and reports `configError`.
- **Optional ops degrade.** A missing read answers empty; a missing write throws `UnsupportedError`. `getScanStatus` without `scanStatus` is an error, not `scanning: false`.
- **Plugins are untrusted code.** The compose service mounts only `state/router/`; do not widen that mount, and do not give the router the Docker socket or the root `.env`.
