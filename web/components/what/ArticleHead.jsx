export default function ArticleHead() {
  return (
    <section className="bs-hero">
      <div className="bs-hero-head">
        <p className="bs-eyebrow">A REAL INTERNET RADIO STATION</p>
        <h1 className="bs-hero-title">
          The radio station with a DJ who never sleeps.
        </h1>
        <p className="bs-hero-deck">
          One stream, an LLM behind the desk, and a music library that already
          belongs to you. We spent a week tuned in to find out what a personal
          radio station actually feels like.
        </p>
      </div>

      <div
        className="flex flex-wrap items-baseline justify-center"
        style={{
          gap: 16,
          fontSize: 10,
          letterSpacing: '0.24em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: 'var(--muted)',
          borderTop: '1px solid var(--separator-strong)',
          borderBottom: '1px solid var(--separator-strong)',
          padding: '12px 0',
          marginBottom: 0,
        }}
      >
        <span style={{ color: 'var(--ink)' }}>A personal radio station</span>
        <span aria-hidden="true">·</span>
        <span>Broadcasting from a homelab</span>
        <span aria-hidden="true">·</span>
        <span style={{ color: 'var(--accent)' }}>Open source</span>
      </div>
    </section>
  );
}
