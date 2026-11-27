import { Suspense } from 'react';
import Link from 'next/link';
import { AnimatedLink } from '@/components/ui/animated-link';
import PluginCard from '@/components/plugins/PluginCard';
import s from '@/components/plugins/plugins.module.css';
import { CatalogGridSkeleton } from '@/components/ui/catalog-skeleton';
import {
  CountStamp,
  CountStampSkeleton,
  EmptyCatalog,
  InstallSteps,
  PosterHero,
  SubmitSlip,
} from '@/components/community/Furniture';
import { getAllPlugins, type CommunityPlugin } from '@/lib/plugins';
import { pluginSubmitUrl, reportPluginUrl, COMMUNITY_REPO_URL } from '@/lib/repo';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Plugins',
  description:
    'Music-source plugins for SUB/WAVE: play your station from Emby, Funkwhale, a folder of files or anything else the router does not speak out of the box. Browse them, or submit your own.',
  path: '/plugins',
});

// Render per-request so the canonical/og:url pick up the runtime SITE_URL; the
// catalog fetch keeps its own ISR window (see /apps).
export const dynamic = 'force-dynamic';

// GitHub Issue Forms in the community catalog repo; a workflow there turns the
// issue into a one-file PR, which a maintainer reviews as code (#2413).
const SUBMIT_URL = pluginSubmitUrl();
const REPORT_URL = reportPluginUrl();

// These take the in-flight promise, so one render issues one catalog fetch.

async function PluginsStamp({ plugins }: { plugins: Promise<CommunityPlugin[]> }) {
  return <CountStamp count={(await plugins).length} noun="plugin" />;
}

async function PluginsPanel({ plugins }: { plugins: Promise<CommunityPlugin[]> }) {
  const all = await plugins;
  if (all.length === 0) {
    return <EmptyCatalog what="plugin" submitUrl={SUBMIT_URL} cta="add a plugin" />;
  }
  return (
    <ul className={s.grid}>
      {all.map((p, i) => (
        <PluginCard key={p.slug} plugin={p} index={i} />
      ))}
    </ul>
  );
}

export default function PluginsIndex() {
  // Started, not awaited; getAllPlugins degrades to an empty list, so this
  // never rejects.
  const plugins = getAllPlugins();

  return (
    <article>
      <PosterHero
        eyebrow="The Patch Bay"
        title="Source"
        outline="Plugins"
        lede={
          <>
            A station plays from Navidrome, Jellyfin or Plex out of the box. Everything else plugs
            in here: a plugin teaches the station&rsquo;s music router to read another server, or a
            plain folder of files. Each one is code someone wrote and shared, so read it, then
            patch it in.
          </>
        }
        stamp={
          <Suspense fallback={<CountStampSkeleton />}>
            <PluginsStamp plugins={plugins} />
          </Suspense>
        }
      />

      <SubmitSlip
        copy="Wrote a plugin for your server? Patch it into the bay."
        submitUrl={SUBMIT_URL}
        submitLabel="Submit a plugin"
        helpUrl={`${COMMUNITY_REPO_URL}/blob/main/plugins/README.md`}
        helpLabel="How listing works"
      />

      <Suspense fallback={<CatalogGridSkeleton />}>
        <PluginsPanel plugins={plugins} />
      </Suspense>

      <InstallSteps
        steps={[
          <>
            <strong>Read the source</strong> first. A plugin runs inside your station&rsquo;s
            router and can reach your network.
          </>,
          <>
            Copy its folder into your station&rsquo;s <code className="bs-code-inline">router/plugins/</code>{' '}
            as root, and mount any music folder it reads.{' '}
            <Link href="/manual/music-sources" className="bs-link">
              The manual has the steps
            </Link>
            .
          </>,
          <>
            In <strong>Admin → Music source</strong>, open <em>Don&rsquo;t see your server?</em>,
            press <strong>Rescan plugins</strong>, and pick its card.
          </>,
        ]}
      />

      <p className={s.fine}>
        Plugins are written and maintained by their authors, not by SUB/WAVE. A listing means a
        maintainer read the code and its conformance result when it was submitted. It is not a
        guarantee, and it doesn&rsquo;t cover later versions.{' '}
        <AnimatedLink href={REPORT_URL} className="bs-link">
          Report a plugin or request a takedown
        </AnimatedLink>
        .
      </p>
      <p className={s.fine}>
        Writing one?{' '}
        <AnimatedLink
          href="https://github.com/perminder-klair/subwave/blob/main/docs/music-source-plugins.md"
          className="bs-link"
        >
          The plugin guide
        </AnimatedLink>{' '}
        covers the contract, the types and the conformance kit.
      </p>
    </article>
  );
}
