import { AnimatedLink } from '@/components/ui/animated-link';
import CommunityPersonaCard from '@/components/personas/CommunityPersonaCard';
import { fetchCommunityPersonas } from '@/lib/communityPersonas';
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

// Submission opens a GitHub Issue Form (no fork, no YAML). A workflow turns the
// issue into a one-file pull request automatically — see
// .github/workflows/persona-submission.yml. Mirrors the /skills share flow.
const SUBMIT_URL = personaSubmitUrl();

export default async function CommunityPersonasIndex() {
  const personas = await fetchCommunityPersonas();
  const count = personas.length;

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

      {count > 0 ? (
        <p className="bs-stat-strip">
          <span>
            <strong>{count}</strong> {count === 1 ? 'persona' : 'personas'} in the catalog
          </span>
        </p>
      ) : null}

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Dreamed up a DJ worth sharing? Add them to the catalog.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a persona
        </AnimatedLink>
        <AnimatedLink href="/manual/dj" className="bs-station-cta-help">
          How personas work
        </AnimatedLink>
      </div>

      {count > 0 ? (
        <ul className="bs-stations-grid">
          {personas.map((p) => (
            <CommunityPersonaCard key={p.slug} persona={p} />
          ))}
        </ul>
      ) : (
        <p className="bs-news-empty">
          No community personas to show yet — the catalog may still be loading, or this station
          hasn&rsquo;t shipped one. Be the first to{' '}
          <AnimatedLink href={SUBMIT_URL} className="bs-link">
            share a persona
          </AnimatedLink>
          .
        </p>
      )}

      <p className="bs-stations-report">
        Installing is a two-tap job in your station&rsquo;s admin: open{' '}
        <strong>Personas → Community</strong>, then <strong>Install</strong>. The persona joins
        your roster off-air, with your station&rsquo;s default voice — audition it, pick a voice
        and an avatar, then put it on the desk when you&rsquo;re ready.
      </p>
    </article>
  );
}
