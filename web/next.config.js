// Surface the package version (release-please bumps all three package.json
// files in lockstep, so the web build version is the deployed station
// version) to the client bundle for the admin console footer.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('./package.json');

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
