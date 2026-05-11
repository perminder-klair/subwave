'use client';

const POINTS = [
  {
    eyebrow: 'NOT A STREAM-ON-DEMAND APP',
    title: 'Everyone hears the same broadcast.',
    body:
      'Spotify shuffles a playlist just for you. SUB/WAVE is the opposite. One Icecast stream, one moment, one queue — what you hear is what every other listener hears, right now. Tune in late and you miss it. That used to be normal.',
  },
  {
    eyebrow: 'AN LLM WITH A LIBRARY',
    title: 'A DJ that actually picks the next track.',
    body:
      'A small Node service watches the time, the weather, what just played, the season, festivals on the operator’s calendar, and any listener requests. It asks Ollama what should come next and pulls a real song from a Subsonic library. No "algorithm". A taste.',
  },
  {
    eyebrow: 'A VOICE BETWEEN TRACKS',
    title: 'Intros, weather, time checks — generated live.',
    body:
      'The links between songs are written by the LLM in the DJ’s voice, then spoken by Piper TTS, then ducked under the next track by Liquidsoap. No pre-recorded air talent. The station idents are also generated. Everything you hear except the music is rendered on the fly.',
  },
  {
    eyebrow: 'HONEST ABOUT WHAT IT IS',
    title: 'A homelab project that became a real station.',
    body:
      'No round-trip to AWS. No subscriptions. The whole stack — Icecast, Liquidsoap, Controller, Ollama, Piper, Caddy — runs on a single box behind Cloudflare. The source is open. You can run your own with a different DJ persona, a different library, a different city.',
  },
];

export default function WhatIs() {
  return (
    <section className="bs-section">
      <p className="bs-eyebrow">WHAT IS SUB/WAVE</p>
      <h2>A radio station, not a feed.</h2>
      <p className="muted">
        Four ideas that make this different from anything on your phone right now.
      </p>

      <div className="bs-whatis-grid" style={{ marginTop: 16 }}>
        {POINTS.map((p) => (
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
    </section>
  );
}
