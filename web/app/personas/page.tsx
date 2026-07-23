import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import { CatalogGridSkeleton, CatalogStatSkeleton } from '@/components/ui/catalog-skeleton';
import CommunityPersonaCard from '@/components/personas/CommunityPersonaCard';
import { fetchCommunityPersonas, type CommunityPersona } from '@/lib/communityPersonas';
import { pageMeta } from '@/lib/seo';
import { personaSubmitUrl } from '@/lib/repo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Personas',
  description:
    'The community persona catalog — DJ identities shared by other stations. Browse them here, then install any from your station&rsquo;s admin console.',
  path: '/personas',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

// Submission opens a GitHub Issue Form in the community catalog repo (no fork, no
// YAML). A workflow there turns the issue into a one-file PR. Mirrors the /skills
// share flow.
const SUBMIT_URL = personaSubmitUrl();

// Catalog-backed regions, each reading the one in-flight promise rather than
// calling the loader itself — see the note in app/shows/page.tsx.

async function PersonasStat({ personas }: { personas: Promise<CommunityPersona[]> }) {
  const count = (await personas).length;
  if (count === 0) return null;
  return (
    <p className="bs-stat-strip">
      <span>
        <strong>{count}</strong> {count === 1 ? 'persona' : 'personas'} in the catalog
      </span>
    </p>
  );
}

async function PersonasGrid({ personas }: { personas: Promise<CommunityPersona[]> }) {
  const list = await personas;
  if (list.length === 0) {
    return (
      <p className="bs-news-empty">
        No community personas to show yet — the catalog may still be loading, or this station
        hasn&rsquo;t shipped one. Be the first to{' '}
        <AnimatedLink href={SUBMIT_URL} className="bs-link">
          share a persona
        </AnimatedLink>
        .
      </p>
    );
  }
  return (
    <ul className="bs-stations-grid">
      {list.map((p) => (
        <CommunityPersonaCard key={p.slug} persona={p} />
      ))}
    </ul>
  );
}

export default function CommunityPersonasIndex() {
  // Started, not awaited, so the hero + CTA flush before the controller answers.
  const personas = fetchCommunityPersonas();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE GREEN ROOM</p>
        <h1>Community Personas.</h1>
        <p>
          A persona is a DJ identity — a name, a soul, and a few behaviour knobs that shape
          everything they say on air. These are shared by the community and ship with every
          station. Browse them here, then install the ones you like from your own admin
          console — and give them your own voice and face there.
        </p>
      </header>

      <Suspense fallback={<CatalogStatSkeleton />}>
        <PersonasStat personas={personas} />
      </Suspense>

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Dreamed up a DJ worth sharing? Add them to the catalog.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a persona
        </AnimatedLink>
        <AnimatedLink href="/manual/dj" className="bs-station-cta-help">
          How personas work
        </AnimatedLink>
      </div>

      <Suspense fallback={<CatalogGridSkeleton />}>
        <PersonasGrid personas={personas} />
      </Suspense>

      <p className="bs-stations-report">
        Installing is a two-tap job in your station&rsquo;s admin: open{' '}
        <strong>Personas → Community</strong>, then <strong>Install</strong>. The persona joins
        your roster off-air, with your station&rsquo;s default voice — audition it, pick a voice
        and an avatar, then put it on the desk when you&rsquo;re ready.
      </p>
    </article>
  );
}
