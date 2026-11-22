import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import AppCard from '@/components/apps/AppCard';
import AppTypeFilter from '@/components/apps/AppTypeFilter';
import s from '@/components/apps/apps.module.css';
import { CatalogGridSkeleton } from '@/components/ui/catalog-skeleton';
import {
  CountStamp,
  CountStampSkeleton,
  EmptyCatalog,
  InstallSteps,
  PosterHero,
  SubmitSlip,
} from '@/components/community/Furniture';
import { getAllApps, typeCounts, type CommunityApp } from '@/lib/apps';
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

async function AppsStamp({ apps }: { apps: Promise<CommunityApp[]> }) {
  return <CountStamp count={(await apps).length} noun="app" />;
}

async function AppsShelf({ apps }: { apps: Promise<CommunityApp[]> }) {
  const all = await apps;
  if (all.length === 0) {
    return <EmptyCatalog what="app" submitUrl={SUBMIT_URL} cta="add an app" />;
  }
  return (
    <>
      <AppTypeFilter bands={typeCounts(all)} total={all.length}>
        <ul className={s.grid}>
          {all.map((a, i) => (
            <AppCard key={a.slug} app={a} index={i} />
          ))}
        </ul>
      </AppTypeFilter>
      {all.some((a) => a.type === 'skin') && (
        <p className={s.fine}>
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
      <PosterHero
        eyebrow="The Receivers"
        title="Community"
        outline="Apps"
        lede={
          <>
            A station speaks a plain, open API, so anyone can build a way to listen to it, or a
            way to boss it around. Here&rsquo;s what people have made: players, bots, terminal
            clients, integrations, and skins for the player it already ships with. Take one
            home, or add your own.
          </>
        }
        stamp={
          <Suspense fallback={<CountStampSkeleton />}>
            <AppsStamp apps={apps} />
          </Suspense>
        }
      />

      <SubmitSlip
        copy="Built something for SUB/WAVE? Put it on the shelf."
        submitUrl={SUBMIT_URL}
        submitLabel="Submit an app"
        helpUrl={`${COMMUNITY_REPO_URL}/blob/main/apps/README.md`}
        helpLabel="How it works"
      />

      <Suspense fallback={<CatalogGridSkeleton />}>
        <AppsShelf apps={apps} />
      </Suspense>

      <InstallSteps
        steps={[
          <>
            Pick one and follow <strong>Get it</strong> to its author&rsquo;s page. Apps install
            from there, <strong>not</strong> from your admin console.
          </>,
          <>
            Give it your station&rsquo;s address, the same one your listeners tune in on.
          </>,
          <>
            Keep your <strong>admin password</strong> to yourself. No app should ever ask you
            for it.
          </>,
        ]}
      />

      <p className={s.fine}>
        Apps are built and maintained by their authors, not by SUB/WAVE — a listing is not an
        endorsement or a security review.{' '}
        <AnimatedLink href={REPORT_URL} className="bs-link">
          Report an app or request a takedown
        </AnimatedLink>
        .
      </p>
    </article>
  );
}
