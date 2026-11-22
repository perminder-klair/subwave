// The Classifieds: the one paid-for box on the landing page, set like a
// broadsheet display ad. Landing.tsx mounts it only on the project's own site
// (IS_OFFICIAL_HOST), because every install serves this landing page and an ad
// has no business on another operator's domain. It is a plain link: no script,
// no pixel, and `rel="sponsored"` tells a crawler what it is.
const PORCH_URL = 'https://www.porch.email/?ref=subwave';

export default function Classified() {
  return (
    <section
      aria-label="Advertisement"
      className="bs-section bs-section--tight items-center"
    >
      <div className="flex w-full max-w-[720px] flex-col items-center gap-4 border border-dashed border-ink/60 px-6 py-8 text-center sm:px-10">
        <p className="m-0 text-[10px] font-bold tracking-[0.3em] text-muted uppercase">
          Advertisement · From the maker of SUB/WAVE
        </p>

        <h2 className="max-w-[18ch] self-center">
          New senders wait on the porch.
        </h2>

        <p className="text-muted">
          <strong className="text-ink">Porch Mail</strong> is a desktop email
          app for the mailbox you already have. The first email from anyone new
          waits at the Gate until you decide where that sender belongs. No
          account with us, no telemetry, and the AI stays off until you pick a
          model. Mac, Windows and Linux, free for 7 days.
        </p>

        <a
          href={PORCH_URL}
          target="_blank"
          rel="sponsored noopener"
          className="bs-tune"
        >
          Visit porch.email <span aria-hidden="true">↗</span>
        </a>

        <p className="m-0 max-w-[52ch] text-[11px]! leading-relaxed text-muted">
          Porch Mail and SUB/WAVE are made by the same person. Porch Mail is a
          paid app, and its sales help pay for the work on SUB/WAVE.
        </p>
      </div>
    </section>
  );
}
