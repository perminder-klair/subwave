import Figure from './Figure';
import EditorialReveal from '../landing/EditorialReveal';

const PANELS = [
  {
    eyebrow: 'DASH',
    title: 'The command center.',
    body:
      'Live status: who is on air, the mood, listener count, weather. See the queue, read the booth log, skip a track, fire a station ID, or send your own words to air as raw or styled voice.',
  },
  {
    eyebrow: 'PERSONAS',
    title: 'The voices on the station.',
    body:
      'Up to twelve DJ identities: name, soul, tagline, talk frequency, voice, and which skills each one may use. One persona is on air at a time; a show can hand it the hour.',
  },
  {
    eyebrow: 'SKILLS',
    title: 'What the DJ does between tracks.',
    body:
      'Each skill is an autonomous segment: a weather check, a news headline, an absurd traffic update, an oddly-specific fact. Toggle each one on, assign it to a persona, or run any one now as an operator override.',
    fig: {
      src: '/screenshots/admin-skills.webp',
      label: 'Admin — Skills',
      caption:
        'Skills: the autonomous segments the DJ runs between tracks. Toggle each, run any one now.',
    },
  },
  {
    eyebrow: 'SHOWS',
    title: 'A weekly schedule you paint.',
    body:
      'A 24×7 grid you brush shows onto. Each show carries a persona, a music mood, and a topic brief: genres, eras, the host’s tone. Autonomous hours fill whatever you leave blank.',
    fig: {
      src: '/screenshots/admin-shows.webp',
      label: 'Admin — Weekly Schedule',
      caption:
        'Shows: brush programming onto a 24×7 grid, each slot its own persona and mood.',
    },
  },
  {
    eyebrow: 'LIBRARY',
    title: 'Search, queue, and tag.',
    body:
      'Search the Navidrome library by text, mood, and energy, queue any track, and browse recent additions. The mood tagger walks the library album-by-album and classifies every track.',
  },
  {
    eyebrow: 'DEBUG & STATS',
    title: 'Health and diagnostics.',
    body:
      'Debug and Stats show health, Liquidsoap logs, LLM call history, and usage at a glance. Settings (TTS, LLM, mixer, jingles) and a danger zone that starts, stops, and restarts the broadcast.',
  },
];

export default function BehindTheDesk() {
  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">PART FOUR · THE CONSOLE</p>
      <h2>Behind the desk.</h2>
      <p className="text-muted">
        Everything a listener hears is shaped from one place: a gated admin
        console with eight panels. This is where the operator actually runs the
        station.
      </p>

      <Figure
        src="/screenshots/admin-dash.webp"
        alt="Admin — Dash"
        label="Admin — Dash"
        caption="The Dash panel: live status, the queue, the booth log, and manual voice control."
      />

      <div className="bs-whatis-grid mt-4">
        {PANELS.map((p) => (
          <article key={p.eyebrow} className="bs-whatis-card">
            <div className="bs-eyebrow mb-2">{p.eyebrow}</div>
            <h3 className="m-0 mb-[10px] text-[clamp(20px,2.2vw,26px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
              {p.title}
            </h3>
            <p className="m-0 text-[14px] leading-[1.55] text-muted">
              {p.body}
            </p>
            {p.fig && (
              <div className="mt-4">
                <Figure
                  src={p.fig.src}
                  alt={p.fig.label}
                  label={p.fig.label}
                  caption={p.fig.caption}
                />
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="bs-whatis-grid mt-4">
        <Figure
          src="/screenshots/admin-library.webp"
          alt="Admin — Library"
          label="Admin — Library"
          caption="Library: search by text, mood, and energy, queue any track, and run the mood tagger."
        />
        <Figure
          src="/screenshots/admin-debug.webp"
          alt="Admin — Debug"
          label="Admin — Debug"
          caption="Debug: a health strip, Liquidsoap logs, and recent LLM calls, refreshed live."
        />
      </div>
    </EditorialReveal>
  );
}
