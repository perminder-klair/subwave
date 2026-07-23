import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import CommunitySkillCard from '@/components/skills/CommunitySkillCard';
import { CatalogGridSkeleton, CatalogStatSkeleton } from '@/components/ui/catalog-skeleton';
import { fetchCommunitySkills, type CommunitySkill } from '@/lib/communitySkills';
import { skillSubmitUrl } from '@/lib/repo';
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
// Submission opens a GitHub Issue Form in the community catalog repo (no fork, no
// YAML). A workflow there turns the issue into a one-file PR; the catalog
// rebuilds on merge. Mirrors the /stations add flow.
const SUBMIT_URL = skillSubmitUrl();
const DOCS_URL = `${REPO}/blob/main/docs/custom-skills.md`;

// Catalog-backed regions, each reading the one in-flight promise rather than
// calling the loader itself — see the note in app/shows/page.tsx.

async function SkillsStat({ skills }: { skills: Promise<CommunitySkill[]> }) {
  const count = (await skills).length;
  if (count === 0) return null;
  return (
    <p className="bs-stat-strip">
      <span>
        <strong>{count}</strong> {count === 1 ? 'skill' : 'skills'} in the catalog
      </span>
    </p>
  );
}

async function SkillsGrid({ skills }: { skills: Promise<CommunitySkill[]> }) {
  const list = await skills;
  if (list.length === 0) {
    return (
      <p className="bs-news-empty">
        No community skills to show yet — the catalog may still be loading, or this station
        hasn&rsquo;t shipped one. Be the first to{' '}
        <AnimatedLink href={SUBMIT_URL} className="bs-link">
          share a skill
        </AnimatedLink>
        .
      </p>
    );
  }
  return (
    <ul className="bs-stations-grid">
      {list.map((s) => (
        <CommunitySkillCard key={s.slug} skill={s} />
      ))}
    </ul>
  );
}

export default function CommunitySkillsIndex() {
  // Started, not awaited, so the hero + CTA flush before the controller answers.
  const skills = fetchCommunitySkills();

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

      <Suspense fallback={<CatalogStatSkeleton />}>
        <SkillsStat skills={skills} />
      </Suspense>

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Made a segment worth sharing? Add it to the catalog.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a skill
        </AnimatedLink>
        <AnimatedLink href={DOCS_URL} className="bs-station-cta-help">
          How it works
        </AnimatedLink>
      </div>

      <Suspense fallback={<CatalogGridSkeleton />}>
        <SkillsGrid skills={skills} />
      </Suspense>

      <p className="bs-stations-report">
        Installing is a two-tap job in your station&rsquo;s admin: open{' '}
        <strong>Skills → Community</strong>, then <strong>Install</strong>. Every skill arrives
        disabled so you can read the brief and enable it on your own terms.
      </p>
    </article>
  );
}
