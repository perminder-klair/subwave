// Google Analytics Measurement ID — resolved at BUILD **and** RUNTIME, mirroring
// lib/site.ts's SITE_URL handling.
//
// The problem it solves: `NEXT_PUBLIC_*` vars are inlined into the bundle at
// build time, so a Measurement ID set only in a running container's env never
// reached the client — operators had to rebuild the web image to turn analytics
// on. Reading a plain (non-`NEXT_PUBLIC`) `GA_ID` lets the value come from the
// container's runtime env instead, so setting it in .env + recreating `web`
// works with no rebuild. docker-compose plumbs the operator's existing
// `NEXT_PUBLIC_GA_ID` into a runtime `GA_ID` env var, so no .env change is
// needed. `NEXT_PUBLIC_GA_ID` stays as the build-time bake for images built
// with it. Empty = analytics off (dev + un-instrumented deploys stay clean).
//
// Runtime caveat is identical to SITE_URL: the value is read where the tree
// renders — per-request for the force-dynamic homepage, at build for statically
// rendered routes. The homepage (the primary entry point) is force-dynamic, so
// the runtime value takes effect there; client-side SPA navigation then carries
// gtag across the rest of the app.
export const GA_ID = (
  process.env.GA_ID ||
  process.env.NEXT_PUBLIC_GA_ID ||
  ''
).trim();
