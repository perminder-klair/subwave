// The Supplements: the project's side pages, set as two inserts tucked into the
// broadsheet. Landing.tsx mounts it only on the project's own site
// (IS_OFFICIAL_HOST), for the same reason as Classified.tsx: every install
// serves this landing page, and the shop is the project selling something on
// another operator's domain. Plain links, no script; the shop's carries
// `rel="sponsored"` because it sells.
const SUPPLEMENTS = [
  {
    tag: 'The Sunday Supplement',
    title: 'Steal the radio.',
    blurb:
      'A sunset drive with a radio wheel you can tune. Every slot on it is a real SUB/WAVE station on air right now, each with its own AI DJ.',
    cta: 'Take the wheel',
    href: 'https://gta.getsubwave.com/',
    rel: 'noopener',
  },
  {
    tag: 'The Gift Shop',
    title: 'Wear the station.',
    blurb:
      'Merch for self-hosted radio, with the DJ behind the counter.',
    cta: 'Visit the shop',
    href: 'https://shop.getsubwave.com/',
    rel: 'sponsored noopener',
  },
] as const;

export default function Supplements() {
  return (
    <section aria-label="Supplements" className="bs-section bs-section--tight">
      <p className="bs-eyebrow">INSIDE THIS EDITION · THE SUPPLEMENTS</p>

      <div className="grid gap-4 sm:grid-cols-2">
        {SUPPLEMENTS.map((s) => (
          <a
            key={s.href}
            href={s.href}
            target="_blank"
            rel={s.rel}
            className="group flex flex-col gap-3 border border-ink/60 px-6 py-7 no-underline transition-colors duration-300 hover:bg-ink/[0.04]"
          >
            <span className="text-[10px] font-bold tracking-[0.3em] text-muted uppercase transition-colors duration-300 group-hover:text-vermilion">
              {s.tag}
            </span>
            <span className="[font-family:var(--font-display),Georgia,serif] text-[30px] leading-none font-black text-ink">
              {s.title}
            </span>
            <span className="text-[14px] leading-relaxed text-muted">{s.blurb}</span>
            <span className="mt-auto flex items-center gap-[6px] pt-2 text-[10px] font-bold tracking-[0.25em] text-ink uppercase transition-colors duration-300 group-hover:text-vermilion">
              {s.cta}
              <span aria-hidden="true">↗</span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
