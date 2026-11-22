import { notFound } from 'next/navigation';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';
import { pageMeta } from '@/lib/seo';
import { IS_OFFICIAL_HOST } from '@/lib/site';
import {
  getCloudCatalog,
  hostedSignupsOpen,
  PORTAL_PRICING_URL,
  PORTAL_WAITLIST_URL,
  type CloudPlan,
} from '@/lib/cloud';

// The Cloud Edition: the project's paid offering (DJ Brain for self-hosted
// stations, and hosted stations), described here and sold on the portal
// (lib/cloud.ts). It exists only on the project's own site: every install
// serves this app, and another operator's domain has no business selling it
// (the same rule as components/landing/Classified.tsx), so elsewhere it 404s.
export const metadata = pageMeta({
  title: 'SUB/WAVE — Cloud',
  description:
    'Run SUB/WAVE without the homework. DJ Brain gives your self-hosted station a hosted model and voice on one key; Hosted runs the whole station for you.',
  path: '/cloud',
});

// Per-request, so IS_OFFICIAL_HOST and the canonical read the runtime SITE_URL.
// The plan fetches keep their own revalidate window (lib/cloud.ts).
export const dynamic = 'force-dynamic';

const nf = new Intl.NumberFormat('en-US');

function planLines(p: CloudPlan): string[] {
  const lines: string[] = [];
  if (p.storageGb) lines.push(`${p.storageGb} GB for your music`);
  lines.push(
    p.voiceHours > 0 ? `${p.voiceHours} hours of DJ voice a month` : 'Bring your own voice',
  );
  if (p.listeningHours) lines.push(`${nf.format(p.listeningHours)} listening hours a month`);
  return lines;
}

function PlanCard({ plan }: { plan: CloudPlan }) {
  return (
    <div className="flex flex-col gap-2 border border-ink/60 px-5 py-5">
      <span className="text-[10px] font-bold tracking-[0.3em] text-muted uppercase">
        {plan.name}
      </span>
      <span className="[font-family:var(--font-display),Georgia,serif] text-[34px] leading-none font-black text-ink">
        ${plan.usd.month}
        <span className="text-[13px] font-normal text-muted"> / month</span>
      </span>
      <ul className="m-0 list-none p-0 text-[13.5px] leading-relaxed text-muted">
        {planLines(plan).map(l => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function Offer({
  part,
  title,
  body,
  plans,
  cta,
}: {
  part: string;
  title: string;
  body: string;
  plans: CloudPlan[] | null;
  cta: { label: string; href: string };
}) {
  return (
    <section className="bs-section">
      <p className="bs-eyebrow">{part}</p>
      <h2>{title}</h2>
      <p className="text-muted">{body}</p>
      {plans && plans.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.map(p => (
            <PlanCard key={p.tier} plan={p} />
          ))}
        </div>
      )}
      <div>
        <a href={cta.href} target="_blank" rel="noopener" className="bs-tune">
          {cta.label} <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}

export default async function CloudPage() {
  if (!IS_OFFICIAL_HOST) notFound();

  const [catalog, signupsOpen] = await Promise.all([getCloudCatalog(), hostedSignupsOpen()]);
  const annualNote = catalog && [...catalog.brain, ...catalog.hosted].some(p => p.annual);

  return (
    <div className="min-h-screen bg-bg text-ink">
      <Masthead />
      <main className="bs-paper">
        <header className="bs-article-head">
          <p className="bs-eyebrow">THE CLOUD EDITION</p>
          <h1>Same station. Less homework.</h1>
          <p className="bs-article-deck">
            SUB/WAVE is free and self-hosted, and it stays that way. If you&rsquo;d rather not run a
            language model, a voice engine or a whole server, these two plans do that part for you.
          </p>
        </header>

        <Offer
          part="PART ONE · DJ BRAIN"
          title="Keep your server. Rent the brain."
          body="Your station stays on your box, with your library. DJ Brain is one key for the model that picks the tracks and writes the links, and on Brain Studio the voice that reads them. No GPU, no provider accounts. Paste the key into the setup wizard and the DJ is on air."
          plans={catalog?.brain ?? null}
          cta={{ label: 'Get a DJ Brain key', href: PORTAL_PRICING_URL }}
        />

        <Offer
          part="PART TWO · HOSTED"
          title="No server at all."
          body="We run the whole station for you at your-name.subw.app: the mixer, the stream, the DJ and its voice, with storage for your music."
          plans={catalog?.hosted ?? null}
          cta={
            signupsOpen
              ? { label: 'Start a hosted station', href: PORTAL_PRICING_URL }
              : { label: 'Join the waitlist', href: PORTAL_WAITLIST_URL }
          }
        />

        <div className="bs-section bs-section--tight">
          <p className="text-[12px]! text-muted">
            Prices in USD.
            {annualNote ? ' Pay yearly and get two months free.' : ''}{' '}
            {catalog ? 'Full details and checkout' : 'Prices and checkout'} are on{' '}
            <a href={PORTAL_PRICING_URL} target="_blank" rel="noopener" className="underline">
              my.getsubwave.com
            </a>
            .
          </p>
        </div>

        <StationFooter />
      </main>
    </div>
  );
}
