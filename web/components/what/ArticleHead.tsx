import Link from 'next/link';
import EditorialReveal from '../landing/EditorialReveal';

export default function ArticleHead() {
  return (
    <EditorialReveal className="bs-hero">
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

        <div className="bs-hero-cta">
          <Link href="/setup" className="bs-tune">
            Setup &nbsp;→
          </Link>
          <a
            href="https://github.com/perminder-klair/subwave"
            target="_blank"
            rel="noreferrer"
            className="bs-tune bs-tune--ghost"
          >
            Source &nbsp;↗
          </a>
        </div>
      </div>

      <div className="mb-0 flex flex-wrap items-baseline justify-center gap-4 border-t border-separator-strong pt-3 text-[10px] font-bold tracking-[0.24em] text-muted uppercase">
        <span className="text-ink">A personal radio station</span>
        <span aria-hidden="true">·</span>
        <span>Broadcasting from a homelab</span>
        <span aria-hidden="true">·</span>
        <span className="text-vermilion">Open source</span>
      </div>
    </EditorialReveal>
  );
}
