import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from '@/components/CodeBlock';

export default function MusicSources() {
  return (
    <ManualPage
      eyebrow="MANUAL · 14"
      title="Music sources."
      intro="SUB/WAVE plays from your own library. Navidrome connects directly; Jellyfin, Plex and anything else go through the music router that ships with the station. Switching is a setting, not a reinstall."
      current="/manual/music-sources"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">TWO WAYS IN</p>
        <h2>Navidrome directly, or the music router.</h2>
        <p>
          <strong>Navidrome</strong> is the default: the station talks to it over the Subsonic
          API, as it always has. Everything else goes through the <strong>music router</strong> —
          a small service in the stack (<code className="bs-code-inline">router</code>) that serves
          the same API from a <em>source plugin</em>. The built-in sources are:
        </p>
        <ul className="bs-list">
          <li><strong>Jellyfin</strong> — favourites become stars, playlists are shared both ways.</li>
          <li><strong>Plex</strong> — a 10-star rating is a star; Plex&rsquo;s sonic analysis drives similar tracks when the server has it.</li>
          <li><strong>Navidrome</strong> — only needed to merge a Navidrome library with another source.</li>
          <li><strong>Demo library</strong> — generated tones and covers, no server. For trying the station before connecting music.</li>
        </ul>
        <p>
          Pick one in <Link href="/admin/settings?section=music">Settings → Music source</Link> (or
          the first step of the setup wizard), fill in its form, press <strong>Test connection</strong>,
          and save. It applies immediately; the auto playlist is rebuilt against the new library.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SWITCHING</p>
        <h2>Your tags and likes follow the music.</h2>
        <p>
          A different library means every track has a different id. After a switch, SUB/WAVE walks
          the new library once and re-links your mood tags, acoustic analysis, likes and blocklist
          by matching each track&rsquo;s artist, title, album and length. Anything it cannot match
          is only removed after you confirm. Show playlist pins and playlist recipes point at the
          old server&rsquo;s playlists, so re-pick those.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">WHAT A SOURCE CAN DO</div>
          <p>
            Not every server offers every signal — Plex has no lyrics, a folder of files has no
            genres. A missing capability never stops the music; the DJ just has fewer discovery
            signals. Settings → Music source shows what yours supports.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PINNING FROM .ENV</p>
        <h2>Env always wins.</h2>
        <p>
          The built-in sources accept their settings from the root <code className="bs-code-inline">.env</code>,
          which locks the field in the admin form:
        </p>
        <CodeBlock>{`JELLYFIN_URL=http://host.docker.internal:8096
JELLYFIN_API_KEY=…
PLEX_URL=http://host.docker.internal:32400
PLEX_TOKEN=…`}</CodeBlock>
        <CodeBlock>{`docker compose up -d router`}</CodeBlock>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PLUGINS</p>
        <h2>Any backend, as a plugin.</h2>
        <p>
          A source plugin is a folder with a manifest and one JavaScript file. Drop it into{' '}
          <code className="bs-code-inline">state/router/plugins/</code>, press{' '}
          <strong>Rescan plugins</strong>, and it appears in the picker with a settings form built
          from its manifest. Plugins are code that runs in the router — install only ones you have
          read and trust.
        </p>
        <p>
          Writing one, the full contract, a worked example and the conformance kit are in{' '}
          <a href="https://github.com/perminder-klair/subwave/blob/main/docs/music-source-plugins.md" className="bs-link">
            docs/music-source-plugins.md
          </a>.
        </p>
      </section>
    </ManualPage>
  );
}
