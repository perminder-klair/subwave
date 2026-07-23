import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Privacy Policy',
  description:
    'How the SUB/WAVE player apps handle your data: no account, no analytics, no trackers. Stations are stored on your device; playback connects straight to the station you choose.',
  path: '/privacy',
});

// Render per-request so the canonical/og:url pick up the runtime SITE_URL — a
// build-time render bakes localhost into image-based installs (see lib/site.ts).
export const dynamic = 'force-dynamic';

export default function PrivacyPage() {
  return (
    <article className="bs-article">
      <header className="bs-article-head">
        <p className="bs-eyebrow">Legal</p>
        <h1>Privacy Policy</h1>
        <p className="bs-article-deck">
          SUB/WAVE is a player for SUB/WAVE internet radio stations, and it is
          made to be boring about your data: no account, no sign-up, no
          analytics, no ads, no third-party trackers. Here is the little that
          does happen.
        </p>
        <p className="bs-article-byline">
          <time dateTime="2026-06-10">Last updated 10 June 2026</time>
        </p>
      </header>

      <div className="bs-rule" />

      <div className="bs-prose">
        <h2>What stays on your device</h2>
        <p>
          The stations you add and the ones you&apos;ve recently tuned to are
          saved locally on your phone so the app remembers them between
          sessions. That list never leaves your device and is not sent to us.
          Delete the app and it&apos;s gone. We have no servers that store
          anything about you.
        </p>

        <h2>What happens when you press play</h2>
        <p>
          When you tune in to a station, the app connects directly to that
          station&apos;s server to fetch the audio stream and the now-playing,
          booth, timeline, and schedule information it shows you. The default is
          the public station at getsubwave.com; you can also point the app at
          any other SUB/WAVE station by address.
        </p>
        <p>
          Like any internet connection, the station&apos;s server can see
          standard request information such as your IP address and the times you
          connect. That server is run by whoever operates the station — for your
          own station, that&apos;s you; for the public station, it&apos;s us at
          getsubwave.com. The app itself does not log or collect this.
        </p>
        <p>
          If you send a song request, the text you write and the name you
          optionally add are sent to the station you&apos;re tuned to, so the DJ
          can answer it on air. That goes to the station&apos;s server, not to
          any separate service.
        </p>

        <h2>Media controls</h2>
        <p>
          The app hands play/pause and now-playing details to your operating
          system so the usual controls work on the lock screen, your headphones,
          CarPlay, and Android Auto. That is handled by iOS and Android, not by
          us.
        </p>

        <h2>What we don&apos;t do</h2>
        <ul>
          <li>No accounts, no email collection, no passwords.</li>
          <li>No analytics or usage-tracking SDKs.</li>
          <li>No advertising and no ad identifiers.</li>
          <li>
            No selling or sharing of personal data, because we don&apos;t
            collect any.
          </li>
        </ul>

        <h2>Children</h2>
        <p>
          SUB/WAVE is a general-audience app and is not directed at children. It
          does not knowingly collect personal information from anyone.
        </p>

        <h2>Changes</h2>
        <p>
          If this policy changes, the date at the top will change with it.
          Material changes will be noted in the app&apos;s release notes.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about privacy: <a href="mailto:p.klair25@gmail.com">p.klair25@gmail.com</a>
        </p>
      </div>
    </article>
  );
}
