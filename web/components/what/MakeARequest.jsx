import Figure from './Figure';

const STEPS = [
  {
    n: '01',
    title: 'Ask in plain language.',
    body:
      'Open the request drawer and type what you want — a song title, an artist, a vibe. No exact spelling, no library browsing. Add your name if you want the DJ to use it on air.',
  },
  {
    n: '02',
    title: 'Get an instant nod.',
    body:
      '“Got it — taking it to the booth.” The acknowledgement is immediate while the matching happens in the background, so the drawer never just sits there.',
  },
  {
    n: '03',
    title: 'The DJ finds the match.',
    body:
      'An LLM reads your request, searches the library, and picks the closest real track. Suggestion chips — built from the current artist, the time of day, the weather — give you a head start if you are undecided.',
  },
  {
    n: '04',
    title: 'It airs, with an intro.',
    body:
      'When the match lands, the drawer shows the track and the DJ’s spoken intro. Your request joins the one queue everyone is hearing — and the DJ may say your name as it goes out.',
  },
];

export default function MakeARequest() {
  return (
    <section className="bs-section">
      <p className="bs-eyebrow">PART THREE · REQUESTS</p>
      <h2>Phone the station, like you used to.</h2>
      <p className="muted">
        Requests are the one place a listener steers the broadcast — and it
        works the way calling a radio station always should have.
      </p>

      <div className="bs-grid-split">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {STEPS.map((s) => (
            <div
              key={s.n}
              style={{
                display: 'grid',
                gridTemplateColumns: '48px 1fr',
                gap: 14,
                alignItems: 'baseline',
              }}
            >
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  color: 'var(--accent)',
                  letterSpacing: '-0.02em',
                }}
              >
                {s.n}
              </span>
              <div>
                <h3
                  style={{
                    margin: '0 0 6px',
                    fontSize: 'clamp(17px, 1.8vw, 21px)',
                    fontWeight: 800,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.2,
                  }}
                >
                  {s.title}
                </h3>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--muted)' }}>
                  {s.body}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="bs-column-rule" aria-hidden="true" />
        <div>
          <Figure
            label="Player — Request a Song"
            caption="The request drawer: type a song, get an instant ack, watch the match land."
            ratio="3 / 4"
          />
        </div>
      </div>
    </section>
  );
}
