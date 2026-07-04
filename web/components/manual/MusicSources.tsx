import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from '@/components/CodeBlock';

export default function MusicSources() {
  return (
    <ManualPage
      eyebrow="MANUAL · 08"
      title="Where the music comes from."
      intro="Your library is pluggable: one source at a time, picked in the onboarding wizard or in Admin → Settings. Three ship today, and they differ mainly in how much the DJ can learn about your music — not in whether the station works."
      current="/manual/music-sources"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE THREE SOURCES</p>
        <h2>Pick one.</h2>
        <ul className="bs-list">
          <li>
            <strong>Navidrome / Subsonic</strong> — the default, and the richest. A
            Subsonic-API server on your network. It layers a Last.fm integration over your
            library, so the DJ gets similar-song suggestions, artist bios to read on air, and
            lyrics that feed the mood tagger.
          </li>
          <li>
            <strong>Plex</strong> — a Plex Media Server over its HTTP API. A real server with
            real listening history (playlists, ratings, play counts), but without the Last.fm
            layer on top.
          </li>
          <li>
            <strong>Local folder</strong> — just a directory of audio files, no server at all.
            Drop files into <code className="bs-code-inline">state/music</code> (or point{' '}
            <code className="bs-code-inline">MUSIC_DIR</code> elsewhere) and hit Rescan.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHAT'S THE SAME EVERYWHERE</p>
        <h2>The station doesn't care which one you pick.</h2>
        <p>
          Playing music, taking requests, the <Link href="/admin/library">Library</Link> page,
          mood tagging, acoustic analysis, the auto playlist — all of it works the same on
          every source. Under the hood, every part of SUB/WAVE talks to your library through
          one facade, and no code branches on which source you chose.
        </p>
        <p>
          What changes is the <strong>discovery tier</strong>: the extra signals the DJ&rsquo;s
          picker can consult when it&rsquo;s deciding what to play next. When a source
          can&rsquo;t serve one of those signals, the picker never offers the DJ that tool.
          Nothing breaks; the station just has fewer hints to draw on.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE FULL COMPARISON</p>
        <h2>What each source can serve.</h2>
        <p>
          The first rows &mdash; playback, tagging, analysis &mdash; work everywhere. The rest
          are discovery signals, and that&rsquo;s where the sources part ways. A dash means the
          source doesn&rsquo;t offer it, so the DJ&rsquo;s picker simply never reaches for it.
        </p>
        <div className="overflow-x-auto">
          <table className="bs-doc-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Navidrome / Subsonic</th>
                <th>Plex</th>
                <th>Local folder</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Playback, search, browse, genres, random</td>
                <td>&#10003;</td>
                <td>&#10003;</td>
                <td>&#10003;</td>
              </tr>
              <tr>
                <td>Mood tagger</td>
                <td>&#10003; full</td>
                <td>&#10003; no lyrics</td>
                <td>&#10003; no lyrics</td>
              </tr>
              <tr>
                <td>Acoustic analyzer (bpm / key / embeddings)</td>
                <td>&#10003;</td>
                <td>&#10003;</td>
                <td>&#10003; fastest &mdash; no download</td>
              </tr>
              <tr>
                <td>Last.fm similar-songs graph</td>
                <td>&#10003;</td>
                <td>&mdash;</td>
                <td>&mdash;</td>
              </tr>
              <tr>
                <td>Sonic similarity (OpenSubsonic)</td>
                <td>&#10003;</td>
                <td>&mdash;</td>
                <td>&mdash;</td>
              </tr>
              <tr>
                <td>Playlists</td>
                <td>&#10003;</td>
                <td>&#10003;</td>
                <td>&mdash;</td>
              </tr>
              <tr>
                <td>Starred / loved tracks</td>
                <td>&#10003;</td>
                <td>&#10003; rated 3&#9733;+</td>
                <td>&mdash;</td>
              </tr>
              <tr>
                <td>Top songs per artist</td>
                <td>&#10003; Last.fm rank</td>
                <td>&#10003; play count</td>
                <td>shuffled sample</td>
              </tr>
              <tr>
                <td>Recently-added albums</td>
                <td>&#10003;</td>
                <td>&#10003; addedAt</td>
                <td>&#10003; file mtime</td>
              </tr>
              <tr>
                <td>Frequently-played albums</td>
                <td>&#10003;</td>
                <td>&#10003; play count</td>
                <td>random sample</td>
              </tr>
              <tr>
                <td>Artist bio / info</td>
                <td>&#10003;</td>
                <td>&mdash;</td>
                <td>&mdash;</td>
              </tr>
              <tr>
                <td>Last.fm crowd tags (tagger enrichment)</td>
                <td>&#10003;</td>
                <td>&#10003;</td>
                <td>&#10003; needs LASTFM_API_KEY</td>
              </tr>
              <tr>
                <td>Lyrics</td>
                <td>&#10003;</td>
                <td>&mdash;</td>
                <td>&mdash;</td>
              </tr>
              <tr>
                <td>Stable track ids</td>
                <td>&#10003; server DB</td>
                <td>&#10003; ratingKey</td>
                <td>path-derived</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHERE THEY DIVERGE</p>
        <h2>Discovery, source by source.</h2>
        <ul className="bs-list">
          <li>
            <strong>Navidrome</strong> — everything&rsquo;s on. The similar-songs and
            sonic-similarity legs dominate the picker; bios and lyrics colour the on-air
            scripts.
          </li>
          <li>
            <strong>Plex</strong> — the similarity legs vanish. Playlists, stars (a track rated
            3&#9733; or higher counts), and play-count ranking take their place. No bios, no
            lyrics: the Plex API doesn&rsquo;t expose them in a shape the picker can use.
          </li>
          <li>
            <strong>Local</strong> — only genre, random, recently-added, per-artist and
            mood/embedding picks remain. Recently-added reads file modified-times and is
            genuinely useful; top-songs and frequent-albums fall back to shuffled samples,
            not real popularity data.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHY TAGGING MATTERS MORE OFF NAVIDROME</p>
        <h2>On Plex and local, the tagger is the DJ&rsquo;s ear.</h2>
        <p>
          Both the mood tagger and the{' '}
          <Link href="/manual/analysis">acoustic analyzer</Link> run on all three sources — full
          parity. The tagger even gets Last.fm crowd tags everywhere, because it calls the
          Last.fm API directly (with your <code className="bs-code-inline">LASTFM_API_KEY</code>)
          rather than asking the music server. Only the lyrics signal is Subsonic-only.
        </p>
        <p>
          That parity matters. On Plex and local, where the Last.fm similar-songs graph is
          gone, mood tags plus acoustic embeddings become the DJ&rsquo;s main way of judging
          what fits next. If you run those sources, tagging and analyzing your library
          isn&rsquo;t optional polish — it&rsquo;s the discovery engine.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">A LOCAL PERK</div>
          <p>
            Local is the fastest library to analyze: it hands the analyzer the file path
            directly, with no download step. (The analyzer only ever deletes its own temp
            downloads — never a path a source handed it. Your files are safe.)
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SWITCHING SOURCES</p>
        <h2>Configure, then reconcile.</h2>
        <p>
          Pick your source in the onboarding wizard, or later in Admin → Settings. Plex and
          local read their config from your root <code className="bs-code-inline">.env</code>:
        </p>
        <CodeBlock>{`# Plex
PLEX_URL=http://your-plex:32400
PLEX_TOKEN=xxxxxxxxxxxx
PLEX_LIBRARY=Music        # optional — pin a music section

# Local folder
MUSIC_DIR=/var/sub-wave/music   # defaults to state/music`}</CodeBlock>
        <p>Two things are worth knowing when you switch:</p>
        <ul className="bs-list">
          <li>
            <strong>Reconcile carries your work across.</strong> Mood and analysis data are
            keyed by track id. Subsonic ids and Plex ratingKeys are stable, but local ids come
            from the file path — so moving or renaming a file re-mints its id. When that
            happens, reconcile matches the orphaned row to the live track with the same
            artist, title and album, carries its tags and embeddings to the new id, and only
            then prunes what&rsquo;s left. Anything the new source tags differently (a
            different album name, say) won&rsquo;t line up, so re-tag whatever didn&rsquo;t
            match.
          </li>
          <li>
            <strong>Reachability spans containers.</strong> Whatever serves the audio has to be
            reachable from the <strong>broadcast</strong> container too — Liquidsoap fetches
            each track itself. For a local folder, that means it must be mounted at the{' '}
            <em>same</em> path into controller, broadcast and analyzer alike. The default{' '}
            <code className="bs-code-inline">state/music</code> already is.
          </li>
        </ul>
      </section>
    </ManualPage>
  );
}
