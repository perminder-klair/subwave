'use client';

import { useEffect, useRef, useState } from 'react';

// Marketing version of the Request section. The real request form is inside
// the embedded player. This presentation is a small carousel of example
// exchanges (listener line → DJ line → track played), one at a time,
// auto-rotating with manual controls.

const EXCHANGES = [
  {
    you: 'play something for the kitchen on a sunday',
    dj:  'You want kitchen-on-a-Sunday energy? We can do that. Caribou coming up — sit with it.',
    track: 'Caribou — Odessa',
    by:    'aanya',
  },
  {
    you: 'punjabi old-school, surprise me',
    dj:  'Old-school it is. Let\'s take this back to a wedding nobody remembers properly.',
    track: 'Daler Mehndi — Tunak Tunak Tun',
    by:    'parm',
  },
  {
    you: 'something for driving home late',
    dj:  'A late-drive request. This one\'s for the M6 at midnight.',
    track: 'Boards of Canada — Roygbiv',
    by:    'sam',
  },
  {
    you: 'i want to feel like im 17 again',
    dj:  'That\'s a tall order at this time of night. We\'ll give it a go.',
    track: 'Neutral Milk Hotel — In the Aeroplane Over the Sea',
    by:    'jo',
  },
];

const ROTATE_MS = 7000;

export default function RequestSection() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const wrapRef = useRef(null);

  // Auto-advance unless hovered / focused / reduced-motion.
  useEffect(() => {
    if (paused) return;
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const id = setInterval(() => setI((x) => (x + 1) % EXCHANGES.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [paused]);

  const goto = (n) => setI(((n % EXCHANGES.length) + EXCHANGES.length) % EXCHANGES.length);
  const prev = () => goto(i - 1);
  const next = () => goto(i + 1);

  const ex = EXCHANGES[i];

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <p className="bs-eyebrow">REQUEST DESK</p>
      <h2
        style={{
          margin: 0,
          fontSize: 'clamp(28px, 3.2vw, 40px)',
          fontWeight: 800,
          letterSpacing: '-0.025em',
          lineHeight: 1.05,
          maxWidth: '22ch',
        }}
      >
        Tell the DJ what to play. In a sentence.
      </h2>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--muted)', maxWidth: '64ch' }}>
        Open the player above and tap Request. Write a mood, a memory, an
        album you half-remember. The LLM reads it, picks something from the
        library, writes an intro that mentions you by name, and the DJ reads
        it on air. Usually under ten seconds end-to-end.
      </p>

      <div
        ref={wrapRef}
        className="bs-carousel"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
        aria-roledescription="carousel"
        aria-label="Example listener requests"
      >
        <div className="bs-carousel-stage" key={i}>
          <div className="bs-bubble bs-bubble-you">
            <div className="bs-bubble-tag">{ex.by}</div>
            <p>"{ex.you}"</p>
          </div>

          <div className="bs-bubble bs-bubble-dj">
            <div className="bs-bubble-tag">DJ</div>
            <p>"{ex.dj}"</p>
          </div>

          <div className="bs-bubble-track">
            <span className="bs-bubble-track-arrow">↳</span>
            <span className="bs-bubble-track-eyebrow">NOW PLAYING</span>
            <span className="bs-bubble-track-name">{ex.track}</span>
          </div>
        </div>

        <div className="bs-carousel-controls">
          <button
            type="button"
            className="bs-carousel-arrow"
            onClick={prev}
            aria-label="Previous example"
          >
            ←
          </button>

          <div className="bs-carousel-dots" role="tablist">
            {EXCHANGES.map((_, n) => (
              <button
                key={n}
                type="button"
                role="tab"
                aria-selected={n === i}
                aria-label={`Example ${n + 1} of ${EXCHANGES.length}`}
                className="bs-carousel-dot"
                data-active={n === i ? 'true' : 'false'}
                onClick={() => goto(n)}
              />
            ))}
          </div>

          <button
            type="button"
            className="bs-carousel-arrow"
            onClick={next}
            aria-label="Next example"
          >
            →
          </button>

          <div className="bs-carousel-count" aria-hidden="true">
            {String(i + 1).padStart(2, '0')} <span style={{ color: 'var(--muted)' }}>/ {String(EXCHANGES.length).padStart(2, '0')}</span>
          </div>
        </div>
      </div>

      <p style={{
        marginTop: 4,
        fontSize: 12,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
      }}>
        ↑ Try it now — the Request button is inside the player at the top of this page.
      </p>
    </section>
  );
}
