# CLAUDE.md — `web/`

Next.js App Router + Tailwind. Read [`DEPENDENCIES.md`](DEPENDENCIES.md) before upgrading a dependency. The API and the stream default to same-origin (`/api`, `/stream.mp3`); in dev, `web/.env.local` points them at `NEXT_PUBLIC_API_URL=http://localhost:7701` and `NEXT_PUBLIC_STREAM_URL=http://localhost:7702/stream.mp3`. Module header comments carry the reasoning, so read them before changing a module.

## Player

- The player is a shell plus a skin. `components/player/PlayerShell.tsx` mounts the headless core (`PlayerCore.tsx`) and the `<audio>` element and resolves the active skin from `components/skins/index.ts`; the skin contract is in `components/skins/types.ts`. Unknown skin ids fall back to classic.
- A skin consumes only the core contexts, the shared hooks and `StationClient`. It renders the tune-in gate through `useTuneInGate`, honours the theme tokens, and co-locates its styles. Never add skin styles to `globals.css`; the two classic blocks still there are debt.
- The shell's `<audio>` carries `ref={attachAudio}`, never the plain `audioRef`. The private-station gate remounts it mid-session, and an object ref leaves the new node with no listeners (#1232).
- Player and skin fetches go through `lib/stationClient.ts`; install-level calls (themes, onboarding) use `defaultStationClient`. `PlayerPageEffects.tsx` (first-run redirect, audience beacon) mounts only on `/` and `/listen`, never in a showcase embed.
- The TTY skin draws every picture (focus-mode scenes, the scope, the ASCII cover) as characters on one grid painted by `skins/tty/term/AsciiCanvas.tsx`. A drawing names a palette ramp and an intensity, never a colour (`term/palette.ts`), so the same scene works on dark and light themes; block, box, braille and scan-line glyphs are drawn as geometry (`term/glyphs.ts`); and focus mode's card owns the bottom-left, so a scene keeps its focal point right of centre (`scenes/kit.ts`). iPad Safari is the budget: its canvas is CPU-drawn and iOS caps canvas memory, failing silently past it, so the painter blits only changed cells (`term/damage.ts`) from an atlas that grows on demand (`term/atlas.ts`) and zeroes every canvas on unmount.
- Listeners never get a skip: `PlayerCore.tsx` passes `useMediaSession` no `onSkip`, so a stray AirPods double-tap can't skip for everyone.
- MP3 is the floor. `hooks/usePlayer.ts` upgrades to Opus only when three things hold: the station's `stream.opusEnabled` is explicitly `true`, `canPlayType` says `'probably'`, and the browser is neither iOS nor Firefox (both break on chained Ogg at a crossfade). The upgrade lands on the next `tune()`, never on a playing element, and an Opus error pins MP3 for the session.

## Admin forms

- Forms validate against `lib/schemas.generated.ts`, the mirror of `controller/src/schemas/**` (`cd controller && npm run gen:schemas`; never edit it by hand).
- Bind with `lib/form.ts` `useZodForm`, which passes all three react-hook-form generics; drop the third and a `z.coerce.number()` field types as `string`.
- Render through the five bound components in `lib/form-fields.tsx`. Drop to `useController` plus the `components/ui/field.tsx` primitives only for a control they don't cover.
- ARIA comes from `fieldAria(baseId, error, opts)`, never by hand. Base ids derive from the `useFieldArray` `_rhfKey`, and a `useFieldArray` over records with their own `id` passes `keyName: '_rhfKey'`.
- An editor bound to an index path (`personas.${i}.*`) is keyed by its row's id, or `EditorDialog`'s exit animation resurrects a deleted row (#1950).
- A roster delete persists at once through `DELETE /personas/:id` or `DELETE /shows/:id`, then drops the row from the values and the baseline together. Never implement a delete as a whole-roster `save()`, which would post every other unsaved edit.
- Roster sort and filter (`roster-order.ts`) reorder only what is displayed, and every mutation uses the returned form-array `index`. Sorting the form array itself would turn a view into a persisted settings write and renumber open editors.
- Clickable chips use `<Pill onClick pressed>`, which renders a real `<button type="button">`.
- `web/scripts/verify-forms.py` drives every converted form end to end against an isolated stack (the `verify` skill). It makes destructive writes, so it refuses to run without `SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1`. Set that only when the isolated stack, and nothing else, is up on the script's hard-coded `API`/`WEB` ports.

## Admin server state (TanStack Query)

- `lib/admin-query.ts` is the one bridge: `adminResponse`, `adminJson`, `useAdminQuery`, `useAdminMutation`, `useQueryErrorToast`. Cacheable reads, retained polls and cache-affecting writes go through it with a feature-owned key factory. Downloads, previews, credential tests, SSE streams and operator commands stay imperative.
- `AdminQueryProvider` lives inside the authenticated branch of `AdminShell` (and of `WizardShell`) and is keyed by the credential, so a sign-in change destroys the old cache before the new one renders. Never move it to the root layout or a module-scope client.
- Keys describe server resources and normalised inputs only, and a write invalidates the narrowest family. Normalise in the `queryFn`, never in `select`, because `setQueriesData` writes the raw value. Spread optional query options only when defined: an explicit `staleTime: undefined` replaces the 30 s default with 0.
- Errors are silent by default and toast only through `useQueryErrorToast` or `toastOnError`. Never install a global `QueryCache.onError`.
- A cache read is not a server read. `setQueryData` stamps `dataUpdatedAt` too, so a decision that needs what the server said takes it from the fetch's own success (`dash/never-play.ts`, #2018).
- Whole-document editors (`SchedulePanel`, `WebhooksPanel`) refetch on mount and hydrate only from that read, or a Save overwrites another tab's or MCP client's changes. A later refetch failure leaves the dirty editor visible.
- Resources with several projections update through one shared reconciler: takeovers, Shows rosters, installed skills, playlists (`admin/playlist-cache.ts`) and themes (`reconcileAdminThemesAfterWrite`). A new consumer joins its reconciler in the same change. `library/queries.ts`'s `['library','rows']` family holds only Track lists, and `patchAllRows` handles all three cache shapes.
- Before finishing an admin server-state change, run `node web/scripts/audit-admin-query.mjs` from the repo root and `npm test -- audit-admin-query` in `web/`. Never hide a retained read by renaming its helper. After touching the Library page, also run `verify-library-search.py` and `verify-query-cache.py` against the verify stack.

## Drawings

- The isometric kit (`components/iso/`) is shared by AXO, Platter and the landing and admin figures. Construction lines mean not built, not checked or nothing yet; ink means real. A figure's resting CSS is its finished still frame: motion layers on only under `prefers-reduced-motion: no-preference`, and `html.lite` kills it. Words a reader needs go in HTML beside the drawing, never in SVG text.
- An SVG `filter` on a perfectly vertical or horizontal line has a zero-width box, so its default filter region is empty and the line vanishes. Glow such a line with a wider, fainter stroke beneath it.
- A canvas or WebGL drawing reads theme colours through `lib/theme-rgb.ts` (`readThemeRgb` + `watchTheme`), never a hex literal. The Observatory galaxy names tones, and `observatory/palette.ts` turns them into the live theme's night sky, ramp and labels.
- The landing "Press Run" plates (`lib/press-run-plates.ts`) are screenshots. When a skin's look changes, re-capture them against a running station with `cd web && npm i --no-save playwright sharp && npx tsx scripts/capture-gallery.mjs`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
