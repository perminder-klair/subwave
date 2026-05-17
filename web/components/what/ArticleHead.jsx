export default function ArticleHead() {
  return (
    <section className="bs-hero" style={{ paddingBottom: 0 }}>
      <div className="bs-hero-head">
        <p className="bs-eyebrow">FEATURE · THE STATION</p>
        <h1 className="bs-hero-title">
          Inside SUB/WAVE — the radio station that runs itself.
        </h1>
        <p className="bs-hero-deck">
          One stream, an LLM behind the desk, and a music library that already
          belongs to you. We spent a week tuned in to find out what a personal
          radio station actually feels like.
        </p>
      </div>

      <div
        className="flex flex-wrap items-baseline"
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
        }}
      >
        <span style={{ color: 'var(--ink)' }}>By the SUB/WAVE Desk</span>
        <span aria-hidden="true">·</span>
        <span>May 2026</span>
        <span aria-hidden="true">·</span>
        <span style={{ color: 'var(--accent)' }}>Eight minute read</span>
      </div>

      <div className="bs-drop-cap" style={{ fontSize: 16, lineHeight: 1.6, maxWidth: '64ch' }}>
        Streaming apps gave everyone their own private channel. A playlist tuned
        to you, shuffled for you, paused the second you look away. SUB/WAVE goes
        the other direction entirely. It is one Icecast stream — a single
        broadcast every listener hears at the same moment — picked, announced,
        and mixed by software running on a single box in someone&apos;s home.
        There is no skip button. There is no &ldquo;for you.&rdquo; You tune in,
        and you hear whatever is on the air right now, the same as everyone else.
        What follows is a tour of the station: the player listeners see, the AI
        DJ between the tracks, and the console the operator runs it all from.
      </div>
    </section>
  );
}
