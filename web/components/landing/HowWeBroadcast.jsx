'use client';

import { Fragment } from 'react';

const BOXES = [
  { label: 'ICECAST', tone: 'default', note: 'one stream' },
  { label: 'LIQUIDSOAP', tone: 'default', note: 'mixer' },
  { label: 'CONTROLLER', tone: 'default', note: 'node.js' },
  { label: 'DJ BRAIN', tone: 'accent', note: 'ollama' },
];

export default function HowWeBroadcast() {
  return (
    <section>
      <div className="bs-eyebrow">HOW WE BROADCAST</div>
      <h3
        style={{
          margin: '14px 0 18px',
          fontSize: 'clamp(24px, 3vw, 36px)',
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          fontWeight: 800,
        }}
      >
        A real internet radio station. Not a stream-on-demand app.
      </h3>

      <div
        className="bs-drop-cap"
        style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 64 + '0ch' }}
      >
        Single Icecast stream — every listener hears the same broadcast at the
        same time. Liquidsoap mixes music, crossfades, ducks the DJ voice over
        the bed, and rotates jingles. The Controller is a small Node.js
        process that picks tracks via Ollama using time, weather, festivals,
        and listener requests. Piper renders the DJ's voice on the fly.
        Four cooperating processes, file-based IPC, one stream out.
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
            {i < BOXES.length - 1 && (
              <div className="bs-arrow">⟶</div>
            )}
          </Fragment>
        ))}
      </div>

      <p
        style={{
          marginTop: 24,
          fontSize: 12,
          letterSpacing: '0.05em',
          color: 'var(--muted)',
          maxWidth: '64ch',
        }}
      >
        Everything between Controller and Liquidsoap moves through plain files
        in a shared volume — <code style={{ fontFamily: 'inherit', color: 'var(--ink)' }}>next.txt</code>,
        <code style={{ fontFamily: 'inherit', color: 'var(--ink)' }}>say.txt</code>,
        <code style={{ fontFamily: 'inherit', color: 'var(--ink)' }}>now-playing.json</code>.
        No socket. No message queue. The Unix way.
      </p>
    </section>
  );
}
