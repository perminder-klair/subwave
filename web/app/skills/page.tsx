import { Suspense } from 'react';
import CommunitySkillCard, { SkillTicker } from '@/components/skills/CommunitySkillCard';
import s from '@/components/skills/skills.module.css';
import { CatalogGridSkeleton } from '@/components/ui/catalog-skeleton';
import {
  CountStamp,
  CountStampSkeleton,
  EmptyCatalog,
  InstallSteps,
  PosterHero,
  SubmitSlip,
} from '@/components/community/Furniture';
import { fetchCommunitySkills, type CommunitySkill } from '@/lib/communitySkills';
import { skillSubmitUrl } from '@/lib/repo';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Skills',
  description:
    'The community skill catalog: prompt-only DJ segments other operators wrote and sent in. Read the briefs here, install them from your own admin console.',
  path: '/skills',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

const REPO = 'https://github.com/perminder-klair/subwave';
// Submission opens a GitHub Issue Form in the community catalog repo; a workflow
// turns it into a one-file PR and the catalog rebuilds on merge.
const SUBMIT_URL = skillSubmitUrl();
const DOCS_URL = `${REPO}/blob/main/docs/custom-skills.md`;

// Each region reads the one in-flight promise rather than calling the loader
// itself — see the note in app/shows/page.tsx.

async function SkillsStamp({ skills }: { skills: Promise<CommunitySkill[]> }) {
  return <CountStamp count={(await skills).length} noun="skill" />;
}

async function SkillsFloor({ skills }: { skills: Promise<CommunitySkill[]> }) {
  const list = await skills;
  if (list.length === 0) {
    return <EmptyCatalog what="skill" submitUrl={SUBMIT_URL} cta="share a skill" />;
  }
  return (
    <>
      <SkillTicker skills={list} />
      <ul className={s.grid}>
        {list.map((sk, i) => (
          <CommunitySkillCard key={sk.slug} skill={sk} index={i} />
        ))}
      </ul>
    </>
  );
}

export default function CommunitySkillsIndex() {
  // Started, not awaited, so the hero + slip flush before the controller answers.
  const skills = fetchCommunitySkills();

  return (
    <article>
      <PosterHero
        eyebrow="The Exchange"
        title="Community"
        outline="Skills"
        lede={
          <>
            A skill is a segment the DJ can air between tracks. You write a short brief saying
            what to cover and when to stay quiet; the DJ writes the actual words at air time,
            around whatever is playing. Every lot on the floor came from another operator, and
            they ship with every station.
          </>
        }
        stamp={
          <Suspense fallback={<CountStampSkeleton />}>
            <SkillsStamp skills={skills} />
          </Suspense>
        }
      />

      <SubmitSlip
        copy="Taught your DJ something good? Put it on the floor."
        submitUrl={SUBMIT_URL}
        submitLabel="Share a skill"
        helpUrl={DOCS_URL}
        helpLabel="How it works"
      />

      <Suspense fallback={<CatalogGridSkeleton />}>
        <SkillsFloor skills={skills} />
      </Suspense>

      <InstallSteps
        steps={[
          <>
            Open <strong>Skills → Community</strong> in your station&rsquo;s admin.
          </>,
          <>
            Hit <strong>Install</strong>. Every skill arrives <strong>switched off</strong>.
          </>,
          <>Read the brief, tweak it if you like, then switch it on and let the DJ air it.</>,
        ]}
      />
    </article>
  );
}
