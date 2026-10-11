import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import AppCard from '@/components/apps/AppCard';
import AppTypeFilter from '@/components/apps/AppTypeFilter';
import { CatalogGridSkeleton, CatalogStatSkeleton } from '@/components/ui/catalog-skeleton';
import { getAllApps, appStats, presentTypes, type CommunityApp } from '@/lib/apps';
import { appSubmitUrl, reportAppUrl, COMMUNITY_REPO_URL } from '@/lib/repo';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Apps',
  description:
    'Apps and integrations built for SUB/WAVE stations: players, bots, terminal clients, MCP servers and more. Browse what the community has made, or submit your own.',
  path: '/apps',
});

// Render per-request so the canonical/og:url pick up the runtime SITE_URL.
// The directory fetch keeps its own ISR revalidate window (explicit per-fetch
// options win over the force-dynamic no-store default).
export const dynamic = 'force-dynamic';

// GitHub Issue Forms in the community catalog repo; a workflow there turns the
// issue into a one-file PR.
const SUBMIT_URL = appSubmitUrl();
const REPORT_URL = reportAppUrl();

// These take the in-flight promise rather than calling getAllApps() themselves,
// so one render issues one catalog fetch however many boundaries read it.

async function AppsStat({ apps }: { apps: Promise<CommunityApp[]> }) {
  const { count, types } = appStats(await apps);
  if (count === 0) return null;
  return (
    <p className="bs-stat-strip">
      <span>
        <strong>{count}</strong> {count === 1 ? 'app' : 'apps'}
      </span>
      <span aria-hidden="true" className="bs-stat-sep">
        ·
      </span>
      <span>
        <strong>{types}</strong> {types === 1 ? 'kind' : 'kinds'}
      </span>
    </p>
  );
}

async function AppsGrid({ apps }: { apps: Promise<CommunityApp[]> }) {
  const all = await apps;
  if (all.length === 0) {
    return (
      <p className="bs-news-empty">
        No apps on the directory yet. Built something? Be the first to add it above.
      </p>
    );
  }
  return (
    <>
      <AppTypeFilter types={presentTypes(all)}>
        <ul className="bs-stations-grid">
          {all.map((a) => (
            <AppCard key={a.slug} app={a} />
          ))}
        </ul>
      </AppTypeFilter>
      {all.some((a) => a.type === 'skin') && (
        <p className="bs-stations-report">
          Skins are player faces built into the web app, not add-ons a running station can
          install. Taking one home means copying its source into your own deployment and
          registering it in <code className="bs-code-inline">components/skins</code>.
        </p>
      )}
    </>
  );
}

export default function AppsIndex() {
  // Started, not awaited — see the note on /stations. getAllApps degrades to an
  // empty list on any catalog failure, so this never rejects.
  const apps = getAllApps();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE RECEIVERS</p>
        <h1>Apps.</h1>
        <p>
          A station speaks a plain, open API, so anyone can build a way to listen to it, or a
          way to boss it around. Here&rsquo;s what people have made: players, bots, terminal
          clients, integrations, and skins for the player it already ships with. Take one
          home, or add your own.
        </p>
      </header>

      <Suspense fallback={<CatalogStatSkeleton />}>
        <AppsStat apps={apps} />
      </Suspense>

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Built something for SUB/WAVE? Put it on the shelf.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Submit an app
        </AnimatedLink>
        <AnimatedLink
          href={`${COMMUNITY_REPO_URL}/blob/main/apps/README.md`}
          className="bs-station-cta-help"
        >
          How it works
        </AnimatedLink>
      </div>

      <Suspense fallback={<CatalogGridSkeleton />}>
        <AppsGrid apps={apps} />
      </Suspense>

      <p className="bs-stations-report">
        Apps are built and maintained by their authors, not by SUB/WAVE — a listing is not an
        endorsement or a security review. No app should ever ask you for your station&rsquo;s
        admin password.{' '}
        <AnimatedLink href={REPORT_URL} className="bs-link">
          Report an app or request a takedown
        </AnimatedLink>
        .
      </p>
    </article>
  );
}
