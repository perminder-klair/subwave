import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from '@/components/CodeBlock';

export default function MusicSources() {
  return (
    <ManualPage
      eyebrow="MANUAL · 14"
      title="Music sources."
      intro="SUB/WAVE plays from your own library: Navidrome, Jellyfin, Plex, a source plugin, or a demo library while you get started. Pick it on one page, and switching later keeps your tags and likes."
      current="/manual/music-sources"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">WHERE IS YOUR MUSIC?</p>
        <h2>Pick your library.</h2>
        <p>
          Open <Link href="/admin/music">Admin → Music source</Link> (or the first step of the
          setup wizard) and choose a card:
        </p>
        <ul className="bs-list">
          <li><strong>Navidrome</strong> — the recommended source: the station talks to it directly over the Subsonic API, as it always has. Any Subsonic-compatible server works the same way.</li>
          <li><strong>Jellyfin</strong> — favourites become stars, playlists are shared both ways. Needs the server URL and an API key (Dashboard → API Keys).</li>
          <li><strong>Plex</strong> — a 10-star rating is a star; Plex&rsquo;s sonic analysis drives similar tracks when the server has it. Needs the server URL and a token.</li>
          <li><strong>Installed plugins</strong> — any other backend, such as the example <em>Music folder</em> plugin that plays files straight from disk.</li>
          <li><strong>Demo library</strong> — generated tones, no server. Hear the DJ, jingles and mixer working, then connect your real library.</li>
        </ul>
        <p>
          Everything but direct Navidrome is served by the <strong>music router</strong>, a small
          service in the stack (<code className="bs-code-inline">router</code>) that speaks the same
          API from a <em>source plugin</em>. On a Navidrome station it sits idle. Under{' '}
          <em>Combine several libraries (advanced)</em> you can merge two sources into one station,
          or reach Navidrome through the router. Nothing is de-duplicated, so an album both servers
          hold appears twice.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SWITCHING</p>
        <h2>Your tags and likes follow the music.</h2>
        <p>
          Pick a card, fill in its settings and press <strong>Switch to …</strong>. SUB/WAVE first
          tests the connection: a wrong key or a server that does not answer stops it there, with
          the reason, and the station stays on what it plays now. Then it asks you to confirm, since
          a switch changes every track id, and the station starts playing from the new library at once.
        </p>
        <p>
          In the background SUB/WAVE walks the new library and re-links your mood tags, acoustic
          analysis, likes and blocklist by matching each track&rsquo;s artist, title, album and
          length. Its progress shows on the Source tab. A server you set up minutes ago may still be
          reading its files; SUB/WAVE carries what already matches and finishes the move once that
          scan ends.
        </p>
        <ul className="bs-list">
          <li>Tracks the new library doesn&rsquo;t have are <strong>kept out of picks, not deleted</strong>, with their tags. Switch back and they return; when you&rsquo;re sure they&rsquo;re gone, press <strong>Remove them</strong> on the Library page.</li>
          <li>Show playlist pins and playlist recipes point at the old server&rsquo;s playlists, so re-pick those.</li>
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">WHAT A SOURCE CAN DO</div>
          <p>
            Not every server offers every signal — Plex has no lyrics, a folder of files has no
            genres. A missing capability never stops the music; the DJ just has fewer discovery
            signals. The Music source page&rsquo;s <strong>Source channels</strong>,{' '}
            <strong>Signal path</strong> and <strong>Service matrix</strong> tabs show each
            source&rsquo;s health and speed, every request the station makes to it, and what it supports.
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
          <code className="bs-code-inline">state/router/plugins/</code> as root
          (<code className="bs-code-inline">sudo cp -r</code>), press{' '}
          <strong>Rescan plugins</strong> (Source tab → <em>Don&rsquo;t see your server?</em>), and it appears as a card with a settings form built
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
