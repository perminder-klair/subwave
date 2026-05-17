import Figure from './Figure';

const POINTS = [
  {
    eyebrow: 'NOW PLAYING',
    title: 'The track, the artist, the booth.',
    body:
      'The player opens on whatever is on air — cover art pulled straight from your library, title, artist, album, and elapsed time. A waveform tracks the audio underneath. It is not your queue. It is the station’s.',
  },
  {
    eyebrow: 'TIMELINE & BOOTH',
    title: 'See what is coming, hear what was said.',
    body:
      'Two drawers slide out from the side. The Timeline shows tracks queued and recently played; the Booth is a live log of every word the DJ has spoken — station IDs, time checks, weather, the links between songs.',
  },
  {
    eyebrow: 'NO SKIP, ON PURPOSE',
    title: 'A shared broadcast, not a remote control.',
    body:
      'There is no skip control for listeners — a stray double-tap on someone’s headphones should not change the song for everyone else. Track-end is the only natural transition. It is radio, so it behaves like radio.',
  },
  {
    eyebrow: 'INSTALL IT',
    title: 'A real app on the lock screen.',
    body:
      'SUB/WAVE installs as a PWA — a home-screen icon, full-screen, offline-aware. The OS media controls wire straight through, so the lock screen, your headphones, and the car display all show the station and pause it cleanly.',
  },
];

export default function OnTheAir() {
  return (
    <section className="bs-section">
      <p className="bs-eyebrow">PART ONE · THE PLAYER</p>
      <h2>One stream, every listener.</h2>
      <p className="muted">
        Open the player and you join a broadcast already in progress. Here is
        what a listener actually sees.
      </p>

      <Figure
        label="Player — Now Playing"
        caption="The listener view: cover art, now-playing metadata, and the live waveform."
      />

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
