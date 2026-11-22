import { Suspense } from 'react';
import CommunityShowCard, { ShowDial, dialFrequencies } from '@/components/shows/CommunityShowCard';
import s from '@/components/shows/shows.module.css';
import { CatalogGridSkeleton } from '@/components/ui/catalog-skeleton';
import {
  CountStamp,
  CountStampSkeleton,
  EmptyCatalog,
  InstallSteps,
  PosterHero,
  SubmitSlip,
} from '@/components/community/Furniture';
import { fetchCommunityShows, type CommunityShow } from '@/lib/communityShows';
import { pageMeta } from '@/lib/seo';
import { showSubmitUrl } from '@/lib/repo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Shows',
  description:
    'The community show catalog: show templates other operators built and sent in, with the topic brief and music filters that steer each one. Install any from your own admin console.',
  path: '/shows',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

// Submission opens a GitHub Issue Form; a workflow turns it into a one-file PR.
// Mirrors the /skills + /personas share flows.
const SUBMIT_URL = showSubmitUrl();
const DOCS_URL = 'https://github.com/perminder-klair/subwave/blob/main/docs/community.md';

// Each region takes the in-flight promise rather than calling
// fetchCommunityShows() itself, so the page issues exactly one request however
// many boundaries read it. Framework-level fetch memoisation can't help here:
// fetchCommunityShows opts out with `cache: 'no-store'`.

async function ShowsStamp({ shows }: { shows: Promise<CommunityShow[]> }) {
  return <CountStamp count={(await shows).length} noun="show" />;
}

async function ShowsGuide({ shows }: { shows: Promise<CommunityShow[]> }) {
  const list = await shows;
  if (list.length === 0) {
    return <EmptyCatalog what="show" submitUrl={SUBMIT_URL} cta="share a show" />;
  }
  const freqs = dialFrequencies(list.length);
  return (
    <>
      <ShowDial shows={list} freqs={freqs} />
      <ul className={s.listings}>
        {list.map((sh, i) => (
          <CommunityShowCard key={sh.slug} show={sh} freq={freqs[i] ?? 98} />
        ))}
      </ul>
    </>
  );
}

export default function CommunityShowsIndex() {
  // Started, not awaited: keeping this component synchronous is what lets the
  // hero, slip and steps flush while the catalog streams in behind the
  // boundaries. fetchCommunityShows resolves to [] on any failure, so holding
  // the promise unawaited can't produce an unhandled rejection.
  const shows = fetchCommunityShows();

  return (
    <article>
      <PosterHero
        eyebrow="The Programme Guide"
        title="Community"
        outline="Shows"
        lede={
          <>
            A show is a slot on the grid: a topic brief for the DJ, plus the music filters that
            decide what plays under it. Produced mode airs it as a full episode, with an intro
            at the top, a feature every hour and a sign-off at the end. Banter puts guest
            co-hosts on the mic together. Spin the dial: every show on it came from another
            operator.
          </>
        }
        stamp={
          <Suspense fallback={<CountStampSkeleton />}>
            <ShowsStamp shows={shows} />
          </Suspense>
        }
      />

      <SubmitSlip
        copy="Built a show that works? Get it in the listings."
        submitUrl={SUBMIT_URL}
        submitLabel="Share a show"
        helpUrl={DOCS_URL}
        helpLabel="How it works"
      />

      <Suspense fallback={<CatalogGridSkeleton />}>
        <ShowsGuide shows={shows} />
      </Suspense>

      <InstallSteps
        steps={[
          <>
            Open <strong>Shows → Community</strong> in your station&rsquo;s admin.
          </>,
          <>
            Hit <strong>Install</strong>. Every show lands <strong>unscheduled</strong>.
          </>,
          <>Pick the persona who hosts it and the hours it runs, and it&rsquo;s on the grid.</>,
        ]}
      />
    </article>
  );
}
