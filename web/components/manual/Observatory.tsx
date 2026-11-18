import Link from 'next/link';
import ManualPage from './ManualPage';
import ManualFigure from './ManualFigure';

export default function Observatory() {
  return (
    <ManualPage
      eyebrow="MANUAL · 08"
      title="The Library Observatory."
      intro="A full-screen, data-art map of everything the DJ has tagged: every track placed by genre and lit by energy, with its full record a click away. It's the DJ's understanding of your library, laid out in one picture."
      current="/manual/observatory"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">OPENING IT</p>
        <h2>One screen, the whole library.</h2>
        <p>
          The Observatory lives at <code className="bs-code-inline">/observatory</code>, reachable from the
          Observatory link in the admin nav. It reads the same tagged library the{' '}
          <Link href="/manual/admin" className="bs-link">admin console</Link> manages, so it sits behind the
          same sign-in: enter your admin credentials once and it opens straight to the map.
        </p>
        <p>
          A track only appears once the DJ has tagged it with a mood and energy (see{' '}
          <Link href="/manual/dj" className="bs-link">How the DJ Works</Link>). A fresh, untagged library
          shows a small sample so the view is never blank.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE MAP</p>
        <h2>Placed by genre, lit by energy.</h2>
        <p>
          Each track is a point, clustered near others in its genre. Colour runs from a quiet tone to the
          theme&apos;s accent by energy: calmer tracks dim, higher-energy tracks bright. The sky is always night,
          drawn in your theme&apos;s own colours. Faint lines wire each track to its nearest neighbour in the
          same scene. Scroll to zoom, drag to pan.
        </p>
        <p>
          The left rail recolours and filters the whole map live. Recolour by <strong>energy</strong>,{' '}
          <strong>tag confidence</strong>, <strong>tag source</strong>, <strong>acoustic analysis</strong>, or
          the acoustic signals the DJ now hears: <strong>loudness</strong>, <strong>pace</strong>, and{' '}
          <strong>voice</strong> (vocal vs instrumental). Filter by scene, mood, energy band, or tag source, or
          search by title, artist, or album. The panels on the right keep a running read of whatever is in view:
          the energy split, the mood field, tempo and loudness histograms, a Camelot key wheel, and the
          major/minor and vocal/instrumental balance.
        </p>
        <p>
          Either side folds away to give the map the room: use the buttons at each end of the top bar, or press{' '}
          <strong>[</strong> and <strong>]</strong>. A folded side stays a slim strip that names what it holds,
          and the Observatory remembers the fold next time.
        </p>
        <ManualFigure
          src="/screenshots/observatory.webp"
          alt="The Library Observatory: thousands of glowing points clustered into a single mass with genre names labelling each region, a rail of colour and filter controls on the left, and panels for energy, mood, tempo and loudness on the right"
          caption="The whole library in one picture — points clustered by genre, lit by energy, with the filter rail on the left and the running read-out of whatever is in view on the right."
          width={2732}
          height={2048}
        />
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">A TRACK UP CLOSE</p>
        <h2>Click a point for its dossier.</h2>
        <p>
          Selecting a track opens its full record: BPM, musical key, energy, length, mood and last.fm tags,
          tag confidence, loudness, and the acoustic-analysis score. A <strong>song-shape</strong> timeline
          charts the track end to end: its pace curve, structural sections, where the intro ends, the vocal
          passages, and how the key moves over time. Below that sit the track's learned embedding fingerprints,
          the text vector and (when analysed) the audio vector, drawn as heatmaps.
        </p>
        <p>
          <strong>Mix Next</strong> lists the closest tracks in vector space, the same similarity the DJ
          leans on when it reaches for what to play next. Those neighbours are wired back onto the map in
          the accent colour so you can see where they sit; picking one flies the camera to it.
        </p>
        <p>
          The dossier isn't just a viewer: <strong>QUEUE ON AIR</strong> pushes the open track straight to
          the broadcast queue, the same operator pick as the admin console's Search tab. And a selected
          track rides the URL, so you can bookmark or share a link that opens the Observatory on that exact
          star.
        </p>
        <ManualFigure
          src="/screenshots/observatory-track.webp"
          alt="A track dossier: title, artist and album, then BPM, key, energy and length, the mood tags with energy and acoustic meters, the text and audio embedding heatmaps, and a Mix Next list of nearest tracks"
          caption="The top of a track dossier — BPM, key, energy and length, then the mood tags and meters. Scrolling on gets you the embedding heatmaps and the Mix Next list."
          width={907}
          height={3272}
          shot="tall"
        />
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">LARGE LIBRARIES</p>
        <h2>From a few hundred to tens of thousands.</h2>
        <p>
          The map draws up to <strong>25,000</strong> tracks by default and can be dialled to 100,000 with the{' '}
          <strong>MAP SIZE</strong> control in the top bar. Beyond the cap it shows a stratified sample spread
          evenly across genres, so the shape stays honest rather than over-weighting whichever genres sort
          first; a header badge tells you when you are seeing a sample.
        </p>
        <p>
          The map draws on the GPU at every size, so it stays smooth into the tens of thousands.
        </p>
      </section>
    </ManualPage>
  );
}
