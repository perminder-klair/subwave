import Link from 'next/link';
import EditorialReveal from '../landing/EditorialReveal';

export default function Coda() {
  return (
    <EditorialReveal className="bs-section items-center text-center">
      <p className="bs-eyebrow self-center">END OF FEATURE</p>
      <h2 className="max-w-[20ch]">The station is on air right now.</h2>
      <p className="text-center text-muted">
        Nothing to scroll, nothing to pick. Tune in and hear what
        the DJ is playing, or stand up your own frequency from the source.
      </p>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-4">
        <Link href="/listen" className="bs-tune">▶ Open the player</Link>
        <Link href="/setup" className="bs-link text-[13px] font-bold tracking-[0.12em] uppercase">
          Run your own station →
        </Link>
      </div>
    </EditorialReveal>
  );
}
