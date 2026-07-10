# design-sync notes — SUB/WAVE web UI

- The design system is NOT a packaged library: it's the shadcn-style primitive set in
  `web/components/ui/` inside the Next.js app. No dist, no build → the converter runs in
  synth-entry mode. `cfg.entry` points at the nonexistent `web/dist/index.js` on purpose:
  the soft miss triggers synth mode while the path walk establishes PKG_DIR=web/.
  Expect a `[NO_DIST] --entry … doesn't exist` warn line on every build — it's benign.
- Tailwind v4 CSS-first: utility classes only exist after a compile. `buildCmd` compiles
  `.design-sync/tailwind-entry.css` (imports `web/app/globals.css`, `@source`s
  `web/components/ui` + `.design-sync/previews`) to `web/.ds-styles.css` (= `cfg.cssEntry`,
  gitignored). **Re-run buildCmd whenever previews or ui components change classes** —
  a new utility class used only in a preview is missing from the CSS until recompiled.
- Fonts: Fraunces / Plus Jakarta Sans / JetBrains Mono are Google fonts the app loads via
  next/font (which also sets `--font-display/--font-sans/--font-mono` on `<html>`).
  Self-hosted copies live in `.design-sync/fonts/` (user approved download; OFL). The
  `:root` font-variable pins ride in `tailwind-entry.css`. `fonts/urls.txt` + `google.css`
  record provenance for re-fetching.
- `next/link` (used by AnimatedLink) is shimmed to a plain anchor via
  `tsconfig.dsync.json` paths → `.design-sync/shims/next-link.tsx` — the real next/link
  throws outside a Next runtime (missing app-router context).
- Sheet + EditorDialog render `m.*` motion components; the app wraps everything in
  `MotionProvider` (LazyMotion strict). It's exported to the bundle via
  `.design-sync/extra-exports.ts` and set as `cfg.provider`.
- Install: `web/` uses npm (`package-lock.json`, node v24). `web/node_modules` was already
  present and healthy on first sync; no `npm ci` was run to avoid disturbing a dev server.

## Preview-authoring learnings (first sync, folded from wave agents)

- Radix `Slider` `defaultValue` must be an ARRAY even for one thumb. Slider is unused in the
  app itself — its preview compositions (crossfade seconds, jingle ratio, ducking depth) are
  invented, keep them plausible-radio.
- Vertical `Separator` needs a sized parent (fixed-height flex row) or the 1px line collapses.
- `Ripple` paints nothing without a relative, sized, overflow-hidden host box; `active={false}`
  honestly renders no rings — that's the true off state, not a bug.
- `Toggle` keeps `text-sm font-medium` (not mono) from its own cva — real styling, not a token
  miss. Its on-state fill is the light newsprint overlay, not vermilion.
- Focus rings, hover, and drag states are interaction-only — skipped in all previews.
- Admin labels fields with the `.field-label` CSS class more often than the `Label` component;
  Label previews pair it with Input/Textarea anyway (same eyebrow tokens, faithful rendering).
- Editing `cfg.overrides`/`cfg.titleMap` invalidates the build stamp: scoped
  `preview-rebuild.mjs` refuses with [CONFIG_STALE] until a full `package-build.mjs` re-stamps.
  In a parallel wave, pause other agents' scoped builds during that full rebuild.

## Known render warns

- `InputGroupAddon` [RENDER_THIN]: children-only container, legitimately paints nothing solo —
  composed inside InputGroup previews instead.
- `CommandDialog` is portal-driven and uncapturable — compose the inner `Command` inline in an
  ink frame (`border: 1px solid var(--ink)`); cmdk auto-selects the first item (highlight row
  renders statically); a controlled non-matching `CommandInput` value shows `CommandEmpty`.
- `ScrollArea` needs `type="always"` or the thumb is invisible in static capture; `ScrollBar`
  is rendered internally by `ScrollArea`.
- Field error state needs BOTH `data-invalid` on `Field` AND a `FieldError` child.
- `AnimatedLink` variants decorate on hover only — previews present links standalone under
  variant eyebrows so they're legible at rest; the motion itself is uncapturable.
- `.ds-sync/package-capture.mjs` + `package-validate.mjs` are locally patched to open pages
  with `reducedMotion: 'reduce'` — without it, motion enter-animations (EditorDialog's JS
  opacity fade) screenshot mid-fade as blank. **This patch lives in gitignored .ds-sync/ and
  is LOST whenever the staged scripts are re-copied on a re-sync — re-apply it** (one-line
  newPage option in each) if EditorDialog captures blank again. Note: reducedMotion alone is
  NOT sufficient — motion still animates opacity under reduce (only transform/layout are
  disabled); the 400ms post-settle wait is what actually settles the fade.
- The bundle re-exports sonner's `toast` via `.design-sync/extra-exports.ts` — the bundled
  `<Toaster/>`'s store is module-scoped, so previews AND designs can only fire toasts through
  `window.SubWave.toast` / `import { toast } from 'sub-wave-web'`.
- Both harness scripts also gained a 400ms post-settle `waitForTimeout` before screenshots
  (same local-patch caveat as reducedMotion: re-apply after re-staging .ds-sync/) — motion
  opacity fades tween even under reduced motion, and sonner mounts on a timer.
- Sonner `<Toaster/>` is position:fixed — inside the card harness it anchors to a transformed
  ancestor with ~0 height and renders off-card. The preview wraps it in a sized
  (`height: 320`) + `transform: translate(0,0)` stage so the fixed list anchors inside the
  cell. The at-rest render is sonner's real collapsed stack (newest card in front).

## Re-sync risks (watch-list for the next run)

- **The .ds-sync harness patches are gone after re-staging**: reducedMotion:'reduce' on both
  scripts' newPage() + the 400ms post-settle waits. Without them EditorDialog (and any future
  motion-fade component) captures blank and Toaster mounts late. Re-apply before trusting a
  blank capture.
- **`web/.ds-styles.css` is generated, gitignored, and REQUIRED by cfg.cssEntry** — on a fresh
  clone run `buildCmd` before the converter or the build warns `! cssEntry: not found` and
  ships tokenless CSS.
- Utility-class coverage in the shipped CSS = classes used in web/ app sources + previews at
  compile time. New previews using new classes silently miss styles until `buildCmd` re-runs.
- Fonts were downloaded from Google Fonts 2026-07-10 (user-approved, OFL) into
  `.design-sync/fonts/`; `google.css`/`urls.txt` record provenance. If families change in
  `app/layout.tsx` (next/font), re-fetch and update `tailwind-entry.css`'s `:root` pins.
- `conventions.md` enumerates classes verified against `_ds_bundle.css` on 2026-07-10 — the
  compiled CSS changes with app source churn, so re-validate the table on each sync.
- Solo grades and wave grades all live in gitignored `.design-sync/.cache/review/`; the
  uploaded `_ds_sync.json` is the cross-machine verification anchor.
- `sub-wave-web` version pin: bundle was built from web@0.39.0, node v24.14.1, tailwind 4.3.0,
  playwright 1.60.0 (chromium-1223 from the shared cache).
