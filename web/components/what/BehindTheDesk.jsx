import Figure from './Figure';

const PANELS = [
  {
    eyebrow: 'DASH',
    title: 'The command center.',
    body:
      'Live status — who is on air, the mood, listener count, weather. See the queue, read the booth log, skip a track, fire a station ID, or send your own words to air as raw or styled voice.',
  },
  {
    eyebrow: 'SETTINGS',
    title: 'TTS, LLM, mixer, jingles.',
    body:
      'Pick the voice engine and the language model, set the crossfade and station location, build station idents. A danger zone starts, stops, and restarts the broadcast.',
  },
  {
    eyebrow: 'PERSONAS',
    title: 'The voices on the station.',
    body:
      'Up to twelve DJ identities — name, soul, tagline, talk frequency, voice, and which skills each one may use. One persona is on air at a time; a show can hand it the hour.',
  },
  {
    eyebrow: 'SHOWS',
    title: 'A weekly schedule you paint.',
    body:
      'A 24×7 grid you brush shows onto. Each show carries a persona, a music mood, and a topic brief — genres, eras, the host’s tone. Autonomous hours fill whatever you leave blank.',
  },
  {
    eyebrow: 'LIBRARY',
    title: 'Search, queue, and tag.',
    body:
      'Search the Navidrome library by text, mood, and energy, queue any track, and browse recent additions. The mood tagger walks the library album-by-album and classifies every track.',
  },
  {
    eyebrow: 'SKILLS & DEBUG',
    title: 'Segments and diagnostics.',
    body:
      'Skills are the autonomous segments the DJ runs between tracks — toggle them on, run any one now. Debug and Stats show health, logs, LLM call history, and usage at a glance.',
  },
];

export default function BehindTheDesk() {
  return (
    <section className="bs-section">
      <p className="bs-eyebrow">PART FOUR · THE CONSOLE</p>
      <h2>Behind the desk.</h2>
      <p className="muted">
        Everything a listener hears is shaped from one place — a gated admin
        console with eight panels. This is where the operator actually runs the
        station.
      </p>

      <Figure
        label="Admin — Dash"
        caption="The Dash panel: live status, the queue, the booth log, and manual voice control."
      />

      <div className="bs-whatis-grid" style={{ marginTop: 16 }}>
        {PANELS.map((p) => (
          <article key={p.eyebrow} className="bs-whatis-card">
            <div className="bs-eyebrow" style={{ marginBottom: 8 }}>{p.eyebrow}</div>
            <h3
              style={{
                margin: '0 0 10px',
                fontSize: 'clamp(20px, 2.2vw, 26px)',
                fontWeight: 800,
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
              }}
            >
              {p.title}
            </h3>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--muted)' }}>
              {p.body}
            </p>
          </article>
        ))}
      </div>

      <div className="bs-grid-split" style={{ marginTop: 16 }}>
        <Figure
          label="Admin — Weekly Schedule"
          caption="Shows: brush programming onto a 24×7 grid, each slot its own persona and mood."
        />
        <div className="bs-column-rule" aria-hidden="true" />
        <Figure
          label="Admin — Debug"
          caption="Debug: a health strip, Liquidsoap logs, and recent LLM calls — refreshed live."
        />
      </div>
    </section>
  );
}
