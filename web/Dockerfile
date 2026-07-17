# Multi-stage build for the Next.js listener UI.
# Produces a slim standalone image (~150MB) suitable for production.

# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
# Public site origin. The routes that emit absolute URLs (canonicals, og:url,
# robots, sitemap) all render per-request now and read the RUNTIME container
# env — a published image can't know the operator's domain at build time (see
# web/lib/site.ts). This build arg remains only as belt-and-suspenders for
# source builds; leaving it unset is fine as long as SITE_URL is set on the
# running container (docker-compose.yml → web.environment).
ARG SITE_URL
ENV SITE_URL=${SITE_URL}
# Google Analytics Measurement ID. This build arg bakes it into the client
# bundle (NEXT_PUBLIC_* is inlined at build). NOTE: it is ALSO resolved at
# RUNTIME now — web/lib/ga.ts reads a plain `GA_ID` env var, which the compose
# files plumb from the operator's NEXT_PUBLIC_GA_ID — so setting it in .env +
# recreating `web` turns analytics on with no rebuild. Unset both → no analytics
# script is emitted.
ARG NEXT_PUBLIC_GA_ID
ENV NEXT_PUBLIC_GA_ID=${NEXT_PUBLIC_GA_ID}
# Version shown in the admin console footer, inlined into the client bundle at
# build time (NEXT_PUBLIC_*), so it must be present *here*. Set from `git
# describe` by scripts/update.sh and the publish-images CI; unset → the build
# falls back to web/package.json (see web/next.config.js).
ARG SUBWAVE_BUILD_VERSION
ENV SUBWAVE_BUILD_VERSION=${SUBWAVE_BUILD_VERSION}
RUN npm run build

# ---- runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=7700
ENV HOSTNAME=0.0.0.0

RUN groupadd -r next && useradd -r -g next next

# Standalone output bundles only the runtime files Next.js needs.
COPY --from=build --chown=next:next /app/.next/standalone ./
COPY --from=build --chown=next:next /app/.next/static ./.next/static
# `public/` is *not* included by the standalone trace — copy it explicitly so
# the service worker (/sw.js) and any other static assets are served at root.
COPY --from=build --chown=next:next /app/public ./public
# The /news routes (and the sitemap) render per-request, so the dispatch
# markdown is read at runtime — the standalone trace doesn't include it.
COPY --from=build --chown=next:next /app/content ./content

USER next
EXPOSE 7700
CMD ["node", "server.js"]
