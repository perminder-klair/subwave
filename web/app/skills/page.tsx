import { AnimatedLink } from '@/components/ui/animated-link';
import CommunitySkillCard from '@/components/skills/CommunitySkillCard';
import { fetchCommunitySkills } from '@/lib/communitySkills';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Skills',
  description:
    'The community skill catalog — prompt-only DJ segments shared by other stations. Browse them here, then install any from your station&rsquo;s admin console.',
  path: '/skills',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

const REPO = 'https://github.com/perminder-klair/subwave';
// Submission opens a GitHub Issue Form (no fork, no YAML). A workflow turns the
// issue into a one-file pull request automatically — see
// .github/workflows/skill-submission.yml. Mirrors the /stations add flow.
const SUBMIT_URL = `${REPO}/issues/new?template=add-skill.yml`;
const DOCS_URL = `${REPO}/blob/main/docs/custom-skills.md`;

export default async function CommunitySkillsIndex() {
  const skills = await fetchCommunitySkills();
  const count = skills.length;

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE WORKSHOP</p>
        <h1>Community Skills.</h1>
        <p>
          A skill is an autonomous segment the AI DJ can air between tracks — a short brief
          telling it what to say, and when to stay quiet. These are shared by the community and
          ship with every station. Browse them here, then install the ones you like from your
          own admin console.
        </p>
      </header>

      {count > 0 ? (
        <p className="bs-stat-strip">
          <span>
            <strong>{count}</strong> {count === 1 ? 'skill' : 'skills'} in the catalog
          </span>
        </p>
      ) : null}

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Made a segment worth sharing? Add it to the catalog.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a skill
        </AnimatedLink>
        <AnimatedLink href={DOCS_URL} className="bs-station-cta-help">
          How it works
        </AnimatedLink>
      </div>

      {count > 0 ? (
        <ul className="bs-stations-grid">
          {skills.map((s) => (
            <CommunitySkillCard key={s.slug} skill={s} />
          ))}
        </ul>
      ) : (
        <p className="bs-news-empty">
          No community skills to show yet — the catalog may still be loading, or this station
          hasn&rsquo;t shipped one. Be the first to{' '}
          <AnimatedLink href={SUBMIT_URL} className="bs-link">
            share a skill
          </AnimatedLink>
          .
        </p>
      )}

      <p className="bs-stations-report">
        Installing is a two-tap job in your station&rsquo;s admin: open{' '}
        <strong>Skills → Community</strong>, then <strong>Install</strong>. Every skill arrives
        disabled so you can read the brief and enable it on your own terms.
      </p>
    </article>
  );
}
