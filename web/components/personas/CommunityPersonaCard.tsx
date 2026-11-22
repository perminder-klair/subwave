import CatalogBrief from '@/components/ui/catalog-brief';
import Credit from '@/components/community/Credit';
import PersonaFace from '@/components/community/PersonaFace';
import { Barcode, LedMeter, SignalBars } from '@/components/community/Meter';
import { lotNo } from '@/components/community/kit';
import type { CommunityPersona } from '@/lib/communityPersonas';
import s from './personas.module.css';

// The /personas showcase, drawn as the Green Room: every community DJ gets a
// backstage pass with a generative portrait (components/community/PersonaFace),
// LED meters for the tone dials, signal bars for how often they talk, and a
// perforated stub with the provenance. A daily headliner and a contact-sheet
// lineup sit above the grid. Browse-only: installation happens in a station's
// admin console. Server components, no client JS.

const FREQUENCY_LEVEL: Record<CommunityPersona['frequency'], number> = {
  silent: 0,
  quiet: 1,
  moderate: 2,
  chatty: 3,
  aggressive: 4,
};

const SCRIPT_LABEL: Record<CommunityPersona['scriptLength'], string> = {
  'one-liner': 'One-liners',
  concise: 'Concise',
  extended: 'Extended',
  storyteller: 'Storyteller',
};

const SCRIPT_LEVEL: Record<CommunityPersona['scriptLength'], number> = {
  'one-liner': 1,
  concise: 2,
  extended: 3,
  storyteller: 4,
};

function Specs({ persona }: { persona: CommunityPersona }) {
  const level = FREQUENCY_LEVEL[persona.frequency] ?? 2;
  const script = SCRIPT_LEVEL[persona.scriptLength] ?? 2;
  return (
    <ul className={s.specs} aria-label="On-air habits">
      <li>
        <span className={s.specKey}>Chatter</span>
        <span className={s.specVal}>
          <SignalBars level={level} /> {persona.frequency}
        </span>
      </li>
      <li>
        <span className={s.specKey}>Scripts</span>
        <span className={s.specVal}>
          <span className={s.scriptBar} aria-hidden="true" data-level={script}>
            <span />
          </span>
          {SCRIPT_LABEL[persona.scriptLength] ?? persona.scriptLength}
        </span>
      </li>
      {persona.djMode && (
        <li>
          <span className={s.specKey}>Mode</span>
          <span className={s.specVal}>DJ mode</span>
        </li>
      )}
      {persona.linkStyle === 'announce' && (
        <li>
          <span className={s.specKey}>Links</span>
          <span className={s.specVal}>Announce only</span>
        </li>
      )}
      {persona.language && (
        <li>
          <span className={s.specKey}>Speaks</span>
          <span className={s.specVal}>{persona.language}</span>
        </li>
      )}
    </ul>
  );
}

function Meters({ persona }: { persona: CommunityPersona }) {
  return (
    <dl className={s.meters}>
      <LedMeter label="Humour" value={persona.humour} />
      <LedMeter label="Warmth" value={persona.warmth} />
      <LedMeter label="Local colour" value={persona.localColour} />
    </dl>
  );
}

export default function CommunityPersonaCard({ persona, index }: { persona: CommunityPersona; index: number }) {
  return (
    <li className={s.pass} id={`persona-${persona.slug}`}>
      <span className={s.punch} aria-hidden="true" />
      <div className={s.passStrip}>
        <span>Booth pass</span>
        <span>No. {lotNo(index)}</span>
      </div>

      <div className={s.passHead}>
        <PersonaFace
          slug={persona.slug}
          humour={persona.humour}
          warmth={persona.warmth}
          localColour={persona.localColour}
          className={s.face}
        />
        <div className={s.passId}>
          <h3 className={s.name}>{persona.displayName}</h3>
          {persona.tagline && <p className={s.tagline}>&ldquo;{persona.tagline}&rdquo;</p>}
        </div>
      </div>

      <Meters persona={persona} />
      <Specs persona={persona} />

      <div className={s.soul}>
        <p className={s.soulLabel}>The soul</p>
        <CatalogBrief text={persona.soul} />
      </div>

      <footer className={s.stub}>
        <Credit by={persona.submittedBy} added={persona.dateAdded} modified={persona.dateModified} />
        <Barcode seed={persona.slug} className={s.barcode} />
      </footer>
    </li>
  );
}

// The soul's opening, as whole sentences: keep adding sentences until the quote
// has some weight (90 chars) without passing 240. Only a first sentence longer
// than that gets cut, at a word.
function pullQuote(soul: string): string {
  const body = soul.trim().replace(/\s+/g, ' ');
  const sentences = body.match(/[^.!?]+[.!?]+["”’)]*(?=\s|$)/g) ?? [];
  let quote = '';
  for (const raw of sentences) {
    const next = quote ? `${quote} ${raw.trim()}` : raw.trim();
    if (next.length > 240) break;
    quote = next;
    if (quote.length >= 90) break;
  }
  if (quote) return quote;
  return body.length > 220 ? `${body.slice(0, 217).replace(/\s+\S*$/, '')}…` : body;
}

/** Today's headliner: a big poster of one persona, rotating daily. */
export function PersonaSpotlight({ persona }: { persona: CommunityPersona }) {
  return (
    <section className={s.spotlight} aria-labelledby="spotlight-name">
      <div className={s.spotFaceWrap}>
        <PersonaFace
          slug={persona.slug}
          humour={persona.humour}
          warmth={persona.warmth}
          localColour={persona.localColour}
          className={s.spotFace}
        />
        <span className={s.spotOnAir} aria-hidden="true">
          <span className="bs-live-dot" /> On air
        </span>
      </div>
      <div className={s.spotBody}>
        <p className="bs-eyebrow">Tonight in the booth</p>
        <h2 id="spotlight-name" className={s.spotName}>
          {persona.displayName}
        </h2>
        {persona.tagline && <p className={s.spotTagline}>{persona.tagline}</p>}
        <blockquote className={s.spotQuote}>
          <p>{pullQuote(persona.soul)}</p>
        </blockquote>
        <Meters persona={persona} />
        <a href={`#persona-${persona.slug}`} className={s.spotLink}>
          Read the full pass <span aria-hidden="true">↓</span>
        </a>
      </div>
    </section>
  );
}

/** The contact sheet: every face as a jump link to its pass. */
export function PersonaLineup({ personas }: { personas: CommunityPersona[] }) {
  return (
    <nav className={s.lineup} aria-label="The lineup">
      <p className={s.lineupLabel}>The lineup</p>
      <ul className={s.lineupList}>
        {personas.map((p) => (
          <li key={p.slug}>
            <a href={`#persona-${p.slug}`} className={s.lineupItem}>
              <PersonaFace
                slug={p.slug}
                humour={p.humour}
                warmth={p.warmth}
                localColour={p.localColour}
                className={s.lineupFace}
              />
              <span className={s.lineupName}>{p.displayName}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
