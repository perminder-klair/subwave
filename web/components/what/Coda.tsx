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
        <Link href="/stations" className="bs-tune">▶ Browse the stations</Link>
        <Link href="/setup" className="bs-link text-[13px] font-bold tracking-[0.12em] uppercase">
          Run your own station →
        </Link>
      </div>

      <p className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] tracking-[0.18em] text-muted uppercase">
        <span>Get the app:</span>
        <a
          href="https://apps.apple.com/app/sub-wave/id6778786696"
          target="_blank"
          rel="noreferrer"
          className="bs-link font-semibold tracking-[inherit] text-ink"
        >
          App Store ↗
        </a>
        <span aria-hidden>·</span>
        <a
          href="https://play.google.com/store/apps/details?id=com.getsubwave.app"
          target="_blank"
          rel="noreferrer"
          className="bs-link font-semibold tracking-[inherit] text-ink"
        >
          Google Play ↗
        </a>
      </p>
    </EditorialReveal>
  );
}
