import { Fragment } from 'react';

const BOXES = [
  { label: 'CONTROLLER', tone: 'default', note: 'node.js' },
  { label: 'DJ BRAIN', tone: 'accent', note: 'llm' },
  { label: 'LIQUIDSOAP', tone: 'default', note: 'mixer' },
  { label: 'ICECAST', tone: 'default', note: 'one stream' },
];

export default function UnderTheHood() {
  return (
    <section className="bs-section">
      <p className="bs-eyebrow">PART FIVE · UNDER THE HOOD</p>
      <h2>Four processes, one box, one stream out.</h2>

      <div
        className="bs-drop-cap"
        style={{ fontSize: 15, lineHeight: 1.6, maxWidth: '64ch' }}
      >
        SUB/WAVE is not a cloud service. The whole stack — Icecast, Liquidsoap,
        the Controller, the LLM, the voice engines, and a Caddy edge — runs on a
        single machine in someone’s home, behind Cloudflare. The Controller is a
        small Node.js process that decides what plays and what gets said.
        Liquidsoap mixes the music, crossfades the tracks, ducks the DJ’s voice
        over the bed, and rotates the jingles. Icecast pushes the one stream out
        to every browser. The pieces talk through plain files in a shared folder
        — no socket, no message queue, the Unix way.
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          alignItems: 'center',
          gap: 8,
          marginTop: 28,
        }}
      >
        {BOXES.map((b, i) => (
          <Fragment key={b.label}>
            <div
              className="bs-box"
              data-tone={b.tone === 'accent' ? 'accent' : undefined}
              style={{ gridColumn: 'span 1' }}
            >
              {b.label}
              <div
                style={{
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  color: 'var(--muted)',
                  marginTop: 4,
                  fontWeight: 500,
                  textTransform: 'lowercase',
                }}
              >
                {b.note}
              </div>
            </div>
            {i < BOXES.length - 1 && <div className="bs-arrow">⟶</div>}
          </Fragment>
        ))}
      </div>

      <p
        style={{
          marginTop: 24,
          fontSize: 14,
          lineHeight: 1.6,
          color: 'var(--muted)',
          maxWidth: '64ch',
        }}
      >
        No subscriptions, no round-trip to a data center, no algorithm tuned to
        keep you scrolling. The whole source is open — so you can run your own
        with a different DJ persona, a different library, and a different city
        on the dateline.
      </p>
    </section>
  );
}
