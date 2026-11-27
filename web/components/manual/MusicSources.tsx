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
          <em>Advanced: route Navidrome through the router, or combine libraries</em> you can serve
          your own Navidrome through the router, starting from the connection the station already
          has and keeping every track id, or merge two sources into one station. Nothing is
          de-duplicated, so an album both servers hold appears twice.
        </p>
        <figure className="bs-manual-figure">
          <video
            controls
            playsInline
            preload="metadata"
            poster="/video/play-from-jellyfin-plex-or-a-folder.webp"
            width={1280}
            height={720}
            aria-label="A rack of music sources: Navidrome, Jellyfin, Plex, a music folder and an installed plugin. A red cable moves from one source to the next, carrying likes, mood tags, analysis and the blocklist, then feeds several sources into one on-air station."
          >
            <source src="/video/play-from-jellyfin-plex-or-a-folder.mp4" type="video/mp4" />
          </video>
          <figcaption className="bs-manual-figcaption">
            <b>FIG.</b> One station, any library: switch sources and your tags and likes come along.
          </figcaption>
        </figure>
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
          A server SUB/WAVE doesn&rsquo;t know yet can be added as a <em>source plugin</em>: a folder
          with a manifest (<code className="bs-code-inline">subwave-source.json</code>, which names the
          plugin and describes its settings form) and one JavaScript file that answers the router&rsquo;s
          questions — find a song, list albums, stream a track. The router does the rest, so a plugin
          only has to talk to its own backend.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">PLUGINS ARE CODE</div>
          <p>
            A plugin runs inside the router with network access. It never sees the station&rsquo;s other
            settings or keys, but install only plugins you have read and trust.
          </p>
        </div>

      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">INSTALL A PLUGIN</p>
        <h2>Copy, rescan, switch.</h2>
        <p>
          Plugins other people have written and shared are listed in the{' '}
          <Link href="/plugins" className="bs-link">plugins directory</Link>, each with what it plugs
          into, the plugin API it targets and its conformance result. A plugin is code that runs in your
          station&rsquo;s router, so read its source before you install it.
        </p>
        <p>
          On a compose install the CLI does steps 1 and 3 for you. It shows the plugin&rsquo;s manifest
          and files, asks before installing, copies it in as root, rescans, and tells you whether the
          router loaded it, undoing the copy if it didn&rsquo;t:
        </p>
        <CodeBlock>{`subwave source add https://github.com/someone/subwave-emby
subwave source add ./my-plugin
subwave source list
subwave source remove emby`}</CodeBlock>
        <p>By hand, or on the all-in-one image and Unraid:</p>
        <p>
          <strong>1. Copy the plugin&rsquo;s folder</strong> into your station&rsquo;s plugins folder, as
          root. The folder belongs to root, so plugin code can never rewrite a plugin.
        </p>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Install</th>
              <th>Plugins folder</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Compose</strong> (the CLI, raw compose, a clone)</td>
              <td><code className="bs-code-inline">state/router/plugins/</code>, or <code className="bs-code-inline">$STATE_DIR/router/plugins/</code> if you set it</td>
            </tr>
            <tr>
              <td><strong>All-in-one image</strong></td>
              <td><code className="bs-code-inline">router/plugins/</code> in the folder you mount at <code className="bs-code-inline">/var/sub-wave</code></td>
            </tr>
            <tr>
              <td><strong>Unraid</strong></td>
              <td><code className="bs-code-inline">router/plugins/</code> in the Appdata path, e.g. <code className="bs-code-inline">/mnt/user/appdata/subwave/router/plugins/</code></td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>2. Mount any files it reads.</strong> A plugin that reads music from the host needs it
          mounted into the router, read-only: a <code className="bs-code-inline">volumes:</code> line on the
          compose <code className="bs-code-inline">router</code> service, or an extra path on the all-in-one
          container (on Unraid, <em>Add another Path, Port, Variable…</em>). The plugin&rsquo;s README says what
          it needs.
        </p>
        <p>
          <strong>3. Rescan.</strong> In <Link href="/admin/music">Admin → Music source</Link>, open{' '}
          <em>Don&rsquo;t see your server?</em> and press <strong>Rescan plugins</strong>. The plugin appears
          as a card tagged <em>installed</em>, with its settings form. One that fails to load says why there,
          and the Doctor lists it.
        </p>
        <p>
          <strong>4. Switch.</strong> Pick its card, fill in the settings and press{' '}
          <strong>Switch to …</strong>: the same test and confirmation as any source.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">TRY THE EXAMPLE</div>
          <p>
            SUB/WAVE ships one example plugin, <em>Music folder</em>, which plays audio files straight from a
            folder laid out as <code className="bs-code-inline">Artist/Album/01 Title.flac</code>. It lives in
            the repository&rsquo;s <code className="bs-code-inline">docs/examples/sources/folder</code> (a CLI install
            doesn&rsquo;t include it, so clone or download that folder). On a compose install, copy it in, mount your music and restart the router, then Rescan, choose{' '}
            <strong>Music folder</strong> and set <em>Folder</em> to <code className="bs-code-inline">/music</code>.
          </p>
        </div>
        <CodeBlock>{`sudo cp -r docs/examples/sources/folder state/router/plugins/
# docker-compose.yml, under the router service's volumes:
#   - /path/to/your/music:/music:ro
docker compose up -d router`}</CodeBlock>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WRITE A PLUGIN</p>
        <h2>One manifest, one file.</h2>
        <p>
          A plugin implements ten required functions (song, album, artist, genres, album lists, songs by
          genre, random songs, search, stream and cover art) and any optional ones its backend supports:
          stars, playlists, lyrics, similar songs, play counts. It returns its backend&rsquo;s own ids and
          whatever fields it knows; the router namespaces the ids and fills in the rest. A missing optional
          function never stops the music, and the Service matrix shows what a source supports.
        </p>
        <p>
          A conformance kit checks a plugin against everything the station relies on, from stable ids to
          real audio and range requests:
        </p>
        <CodeBlock>{`npx @subwave/source-sdk conformance ./my-source --config url=http://server:8096 --config apiKey=…`}</CodeBlock>
        <p>
          The full contract, the manifest fields and a walkthrough of the example are in{' '}
          <a href="https://github.com/perminder-klair/subwave/blob/main/docs/music-source-plugins.md" className="bs-link">
            the plugin guide
          </a>.
        </p>
      </section>
    </ManualPage>
  );
}
