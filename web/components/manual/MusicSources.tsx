import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from '@/components/CodeBlock';

export default function MusicSources() {
  return (
    <ManualPage
      eyebrow="MANUAL · 14"
      title="Music sources."
      intro="SUB/WAVE plays from your own library, through the music router that ships with the station: your Navidrome by default, and Jellyfin, Plex or a plugin beside it or instead of it. Switching is a setting, not a reinstall."
      current="/manual/music-sources"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">HOW IT PLAYS</p>
        <h2>Navidrome by default, anything else beside it.</h2>
        <p>
          Every station plays through the <strong>music router</strong> — a small service in the
          stack (<code className="bs-code-inline">router</code>) that serves the Subsonic API from
          <em> source plugins</em>. Your <strong>Navidrome</strong> is the default source, and it keeps
          the same track ids it always had, so nothing in your library has to move. The built-in
          sources are:
        </p>
        <ul className="bs-list">
          <li><strong>Navidrome</strong> — the station&rsquo;s own Navidrome connection, and the default.</li>
          <li><strong>Jellyfin</strong> — favourites become stars, playlists are shared both ways.</li>
          <li><strong>Plex</strong> — a 10-star rating is a star; Plex&rsquo;s sonic analysis drives similar tracks when the server has it.</li>
        </ul>
        <p>
          Choose them in <Link href="/admin/sources">Admin → Music sources</Link> (or the first step of
          the setup wizard): pick a source, fill in its form, press <strong>Test connection</strong>,
          and save. Add a second source to play both as one library — that is experimental, and
          nothing is de-duplicated. Changes apply immediately; the auto playlist is rebuilt against
          the new library.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">IF THE ROUTER IS DOWN</div>
          <p>
            While the station plays its Navidrome alone, a stopped or stuck router never silences it:
            the controller notices within about twenty seconds, plays Navidrome directly with the same
            track ids, and moves back once the router answers. To bypass the router for good, use
            <strong> Advanced → Play Navidrome directly</strong> on the Sources tab.
          </p>
        </div>
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
            signals. The Plugins tab shows what each source supports, and the Monitor tab shows the
            station&rsquo;s live traffic through the router.
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
          <strong>Rescan plugins</strong> on the Plugins tab, and it appears in the Sources picker with
          a settings form built from its manifest. Plugins are code that runs in the router — install only ones you have
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
