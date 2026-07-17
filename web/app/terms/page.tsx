import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Terms of Use',
  description:
    'The plain terms for using the SUB/WAVE apps and the public station: the software is provided as is, and each station operator is responsible for the music they broadcast and any licences it needs.',
  path: '/terms',
});

// Render per-request so the canonical/og:url pick up the runtime SITE_URL — a
// build-time render bakes localhost into image-based installs (see lib/site.ts).
export const dynamic = 'force-dynamic';

export default function TermsPage() {
  return (
    <article className="bs-article">
      <header className="bs-article-head">
        <p className="bs-eyebrow">Legal</p>
        <h1>Terms of Use</h1>
        <p className="bs-article-deck">
          SUB/WAVE is open-source software and a player for SUB/WAVE internet
          radio stations. These terms are short and plain. The one that matters
          most: whoever runs a station is responsible for the music on it.
        </p>
        <p className="bs-article-byline">
          <time dateTime="2026-06-19">Last updated 19 June 2026</time>
        </p>
      </header>

      <div className="bs-rule" />

      <div className="bs-prose">
        <h2>What SUB/WAVE is</h2>
        <p>
          SUB/WAVE is software for running and listening to a personal internet
          radio station. The code is open source under the MIT licence. Anyone
          can self-host a station; the apps let you listen to the public station
          at getsubwave.com or any other SUB/WAVE station by address. Using the
          apps or the software means you accept these terms.
        </p>

        <h2>Provided &ldquo;as is&rdquo;</h2>
        <p>
          The software and the apps are provided as is, without warranties of
          any kind. We don&apos;t promise the stream is always up, that any
          feature keeps working, or that the AI DJ behaves a particular way. To
          the fullest extent the law allows, we&apos;re not liable for any loss
          arising from using &mdash; or being unable to use &mdash; SUB/WAVE.
        </p>

        <h2>Your station, your responsibility</h2>
        <p>
          SUB/WAVE is a broadcast tool, like the Liquidsoap and Icecast it runs
          on. It grants no rights to any music and clears nothing on your
          behalf. If you run a station, you are the broadcaster: you are
          responsible for the music you play and for obtaining any licences that
          broadcasting it requires in your country. Broadcasting music to people
          who can tune in can count as public performance, which is licensed in
          most places.
        </p>
        <p>
          If you don&apos;t want to arrange licences, keep your station private
          to people you intend, or broadcast only content that&apos;s cleared
          for it &mdash; your own recordings, Creative Commons, royalty-free
          libraries, or public domain. This is general information, not legal
          advice; if you run a public station, check your local rules or talk to
          a lawyer.
        </p>

        <h2>Acceptable use</h2>
        <ul>
          <li>Don&apos;t use SUB/WAVE to broadcast content you have no right to broadcast.</li>
          <li>Don&apos;t use it for anything unlawful, or to harass or harm others.</li>
          <li>
            Don&apos;t abuse the song-request feature &mdash; no spam, and no
            attempts to manipulate or attack the DJ or the station.
          </li>
        </ul>

        <h2>Listening to stations</h2>
        <p>
          Stations other than the public one are run by their own operators. We
          don&apos;t control, endorse, or take responsibility for what a
          third-party station plays or says. When you tune in to a station, you
          connect directly to that operator&apos;s server; what it broadcasts is
          on them, not on us.
        </p>

        <h2>Song requests</h2>
        <p>
          If you send a song request, the text and any name you add go to the
          station you&apos;re tuned to so the DJ can answer it on air. Keep
          requests civil and lawful. An operator can ignore or decline any
          request, and there&apos;s no guarantee a request is played.
        </p>

        <h2>Changes</h2>
        <p>
          If these terms change, the date at the top will change with them.
          Continuing to use SUB/WAVE after a change means you accept the updated
          terms.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms: <a href="mailto:p.klair25@gmail.com">p.klair25@gmail.com</a>
        </p>
      </div>
    </article>
  );
}
