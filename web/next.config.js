// Resolve the version shown in the admin console footer, in priority order:
//   1. SUBWAVE_BUILD_VERSION build-arg — set from `git describe` by
//      scripts/update.sh and the publish-images CI, so an image built off
//      `develop` reports its true, commit-accurate version. (release-please only
//      bumps package.json on `main`; `develop` trails it by a release, so
//      reading package.json here left the sidebar a version behind.)
//   2. `git describe` — for local `npm run dev` / `npm run build`. A Docker
//      build has no .git in its context, so this is skipped there (the build-arg
//      covers that path) and step 3 applies.
//   3. web/package.json — the original source; correct on a tagged checkout.
function resolveAppVersion() {
  const fromEnv = process.env.SUBWAVE_BUILD_VERSION;
  if (fromEnv) return fromEnv.replace(/^v/, '');
  try {
    // execFileSync (no shell) with a fixed, no-user-input command.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process');
    const described = execFileSync(
      'git',
      ['describe', '--tags', '--always', '--dirty'],
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    if (described) return described.replace(/^v/, '');
  } catch {
    // No git available (e.g. inside a Docker build) — fall through.
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./package.json').version;
}

const version = resolveAppVersion();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  // The repo root carries its own package.json/package-lock.json (the
  // `sub-wave` CLI), so Next would otherwise infer the repo root as the
  // workspace root — destabilising module resolution and crashing the dev
  // server when it loads tailwind.config.js through the ESM loader. Pin the
  // root to this directory.
  outputFileTracingRoot: __dirname,
  // Edge redirect for /admin → /admin/dash. The previous approach of a
  // server-component `redirect()` in app/admin/page.tsx crashed Next 15's
  // Router on the post-sign-in re-render: AdminShell renders its sign-in form
  // (instead of children) until auth is set, so the redirecting page is
  // mounted late as a child — and mounting a server component that calls
  // `redirect()` from inside a client-driven re-render trips React with
  // "Rendered more hooks than during the previous render." A config-level
  // redirect handles /admin at the edge so the unauthed shell is never asked
  // to render a redirecting page.
  async redirects() {
    return [{ source: '/admin', destination: '/admin/dash', permanent: true }];
  },
};

module.exports = nextConfig;
