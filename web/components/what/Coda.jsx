import Link from 'next/link';

export default function Coda() {
  return (
    <section className="bs-section" style={{ alignItems: 'center', textAlign: 'center' }}>
      <p className="bs-eyebrow" style={{ alignSelf: 'center' }}>END OF FEATURE</p>
      <h2 style={{ maxWidth: '20ch' }}>The station is on air right now.</h2>
      <p className="muted" style={{ textAlign: 'center' }}>
        There is nothing to scroll and nothing to pick. Tune in and hear what
        the DJ is playing — or stand up your own frequency from the source.
      </p>

      <div
        className="flex flex-wrap items-center justify-center"
        style={{ gap: 16, marginTop: 8 }}
      >
        <Link href="/listen" className="bs-tune">▶ Open the player</Link>
        <Link href="/setup" className="bs-link" style={{ fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700 }}>
          Run your own station →
        </Link>
      </div>
    </section>
  );
}
