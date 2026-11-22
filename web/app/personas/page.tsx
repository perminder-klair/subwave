import { Suspense } from 'react';
import { CatalogGridSkeleton } from '@/components/ui/catalog-skeleton';
import CommunityPersonaCard, {
  PersonaLineup,
  PersonaSpotlight,
} from '@/components/personas/CommunityPersonaCard';
import s from '@/components/personas/personas.module.css';
import {
  CountStamp,
  CountStampSkeleton,
  EmptyCatalog,
  InstallSteps,
  PosterHero,
  SubmitSlip,
} from '@/components/community/Furniture';
import { dailyIndex } from '@/components/community/kit';
import { fetchCommunityPersonas, type CommunityPersona } from '@/lib/communityPersonas';
import { pageMeta } from '@/lib/seo';
import { personaSubmitUrl } from '@/lib/repo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Personas',
  description:
    'The community persona catalog: DJ identities other operators wrote and sent in. Read their souls here, install them from your own admin console.',
  path: '/personas',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

// Submission opens a GitHub Issue Form in the community catalog repo; a workflow
// turns it into a one-file PR.
const SUBMIT_URL = personaSubmitUrl();

// Each region reads the one in-flight promise rather than calling the loader
// itself — see the note in app/shows/page.tsx.

async function PersonasStamp({ personas }: { personas: Promise<CommunityPersona[]> }) {
  return <CountStamp count={(await personas).length} noun="DJ" />;
}

async function GreenRoom({ personas }: { personas: Promise<CommunityPersona[]> }) {
  const list = await personas;
  if (list.length === 0) {
    return <EmptyCatalog what="persona" submitUrl={SUBMIT_URL} cta="share a persona" />;
  }
  const headliner = list[dailyIndex(list.length)];
  return (
    <>
      {headliner && <PersonaSpotlight persona={headliner} />}
      <PersonaLineup personas={list} />
      <ul className={s.grid}>
        {list.map((p, i) => (
          <CommunityPersonaCard key={p.slug} persona={p} index={i} />
        ))}
      </ul>
    </>
  );
}

export default function CommunityPersonasIndex() {
  // Started, not awaited, so the hero + slip flush before the controller answers.
  const personas = fetchCommunityPersonas();

  return (
    <article>
      <PosterHero
        eyebrow="The Green Room"
        title="Community"
        outline="Personas"
        lede={
          <>
            A persona is a DJ identity: a name, a soul, and the handful of dials that shape
            everything they say on air. The soul is the prompt itself, not a written bio, so
            what you read on a pass is what the station hands the model. Every DJ below came
            from another operator, and any station can book them.
          </>
        }
        stamp={
          <Suspense fallback={<CountStampSkeleton />}>
            <PersonasStamp personas={personas} />
          </Suspense>
        }
      />

      <SubmitSlip
        copy="Dreamed up a DJ other stations should meet? Get them a pass."
        submitUrl={SUBMIT_URL}
        submitLabel="Share a persona"
        helpUrl="/manual/dj"
        helpLabel="How personas work"
      />

      <Suspense fallback={<CatalogGridSkeleton />}>
        <GreenRoom personas={personas} />
      </Suspense>

      <InstallSteps
        steps={[
          <>
            Open <strong>Personas → Community</strong> in your station&rsquo;s admin.
          </>,
          <>
            Hit <strong>Install</strong>. The DJ joins your roster off-air, on the
            station&rsquo;s default voice.
          </>,
          <>
            Audition them, give them a voice and a face, then <strong>put them on the desk</strong>.
          </>,
        ]}
      />
    </article>
  );
}
