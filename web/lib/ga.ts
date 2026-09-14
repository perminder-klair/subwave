// GA Measurement ID, resolved at BUILD and RUNTIME, mirroring lib/site.ts.
// `NEXT_PUBLIC_*` is inlined at build time, so the plain `GA_ID` carries the
// container's runtime env (docker-compose plumbs NEXT_PUBLIC_GA_ID into it).
// Empty = off. The value is read where the tree renders: per-request for the
// force-dynamic homepage, at build for static routes.
export const GA_ID = (
  process.env.GA_ID ||
  process.env.NEXT_PUBLIC_GA_ID ||
  ''
).trim();
