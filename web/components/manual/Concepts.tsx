import Link from 'next/link';
import ManualPage from './ManualPage';

// The seven things that get asked over and over — not because they're broken,
// but because the name doesn't say what's underneath. The repo-side copy of
// this material lives in docs/concepts.md; keep the two in step.

const DIALS: { dial: string; low: string; high: string }[] = [
  {
    dial: 'Humour',
    low: 'Plays it straight; wit stays rare and understated.',
    high: 'Leans into dry, playful wit; an aside or a wink is welcome.',
  },
  {
    dial: 'Local Colour',
    low: 'Keeps it universal; skips local references and place-specific colour.',
    high: 'Leans on the local setting — the town, the weather, the hour — as texture.',
  },
  {
    dial: 'Warmth',
    low: 'Keeps a cool, dry distance; lets the music carry the warmth.',
    high: 'Warm and earnest; speaks to the listener like a friend.',
  },
];

const DAYPARTS: { period: string; hours: string }[] = [
  { period: 'early-morning', hours: '05:00 – 09:00' },
  { period: 'morning', hours: '09:00 – 12:00' },
  { period: 'midday', hours: '12:00 – 14:00' },
  { period: 'afternoon', hours: '14:00 – 17:00' },
  { period: 'drive-time', hours: '17:00 – 19:00' },
  { period: 'evening', hours: '19:00 – 22:00' },
  { period: 'late-evening', hours: '22:00 – 01:00' },
  { period: 'after-hours', hours: '01:00 – 05:00' },
];

export default function Concepts() {
  return (
    <ManualPage
      eyebrow="MANUAL · 15"
      title="Concepts, explained."
      intro="Seven things that get asked over and over — not because they're broken, but because the name doesn't tell you what's underneath. What each one is, what changes when you move it, and where the control lives."
      current="/manual/concepts"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">PERSONA TONE</p>
        <h2>Local Colour, and the other two dials.</h2>
        <p>
          Every persona carries three dials from 0 to 10 &mdash;{' '}
          <strong>Humour</strong>, <strong>Local Colour</strong> and{' '}
          <strong>Warmth</strong>. They look like faders, but nothing scales smoothly as
          you drag them. Each one resolves to a <em>band</em>: 0&ndash;3 is low,
          4&ndash;6 is neutral, 7&ndash;10 is high. Only a band away from neutral changes
          anything, so 4, 5 and 6 are the same setting &mdash; and so are 7 and 10.
        </p>
        <p>
          That&rsquo;s on purpose. A model can&rsquo;t hear the difference between a 6 and
          a 7 in a raw &ldquo;7 out of 10&rdquo; instruction, so rather than fake a
          precision that isn&rsquo;t there, the dial picks one of two style directions.
        </p>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Dial</th>
              <th>Turned down</th>
              <th>Turned up</th>
            </tr>
          </thead>
          <tbody>
            {DIALS.map((d) => (
              <tr key={d.dial}>
                <td><strong>{d.dial}</strong></td>
                <td>{d.low}</td>
                <td>{d.high}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <strong>Local Colour</strong> is the one people ask about. It governs how much
          the DJ reaches for <em>where and when you are</em> &mdash; your town,
          today&rsquo;s weather, the hour &mdash; as raw material. Turned up, links open
          with the drizzle outside. Turned down, the same DJ could be broadcasting from
          anywhere.
        </p>
        <p className="text-muted">
          It doesn&rsquo;t add facts: the place, the weather and the clock reach the DJ
          either way, and the dial only decides whether it leans on them. It can&rsquo;t
          invent a second location either &mdash; exactly one place name reaches any
          script, the on-air location under Settings &rarr; Station. A persona left at the
          defaults writes exactly what it wrote before the dials existed. Find them under{' '}
          <Link href="/admin/personas" className="bs-link">Personas</Link> &rarr;
          Behaviour.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">CHOOSING THE NEXT TRACK</p>
        <h2>Candidate pool vs the agent picker.</h2>
        <p>
          Both end in the same place &mdash; one track, handed to the queue &mdash; and
          both run inside a session and get logged. What differs is who does the
          searching.
        </p>
        <p>
          With the <strong>candidate pool</strong>, the station does. It merges up to
          sixteen sources into one shortlist &mdash; mood matches, sonically similar
          tracks, embedding neighbours, the current show&rsquo;s genres and playlists,
          starred and frequently-played, recently added, listener favourites, a wildcard
          and a little pure random &mdash; de-duplicates, applies the recency and artist
          filters, caps it, and asks the model <em>once</em>: pick one of these. One
          round-trip per track, bounded tokens, and it works happily on a small local
          model because there&rsquo;s no tool loop to get lost in. The catch is that the
          model can only choose from what the pool already found.
        </p>
        <p>
          With the <strong>agent</strong> &mdash; the default &mdash; the model drives. It
          gets about eighteen discovery tools (similar songs, tracks like this one, search
          by sound, search by lyrics, by mood, by energy, by genre, deep cuts, recently
          added, tracks toward a journey) and searches the library itself across the
          session&rsquo;s memory before committing. Richer, more coherent across a run,
          and more expensive: several round-trips per track, and it needs a model that is
          genuinely good at multi-step tool calling with a context window of at least
          16,384. Most &ldquo;the DJ stopped without choosing&rdquo; reports are that
          requirement not being met.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">WHICH ONE</div>
          <p>
            Start on <strong>Agent</strong>{' '}if you&rsquo;re on a cloud model or a 12B-class
            local one. Drop to <strong>Candidate pool</strong>{' '}if picks are slow, if the
            DJ keeps re-picking, or if you&rsquo;re on a 9B-class model. Nothing is lost
            either way: the station still picks, still writes links, still honours
            requests. The agent already falls back to the pool on a timeout, so a slot is
            never dropped.
          </p>
        </div>
        <p className="text-muted">
          Two behaviours hold whichever you run. <strong>Variety is enforced after the
          choice, not inside the search</strong> &mdash; the discovery tools carry no
          artist filter on purpose, because filtering inside them gutted the similarity
          pool on smaller libraries; instead a pick that repeats a recent artist triggers
          a re-pick. And <strong>the daily token budget degrades in tiers</strong>: past
          the soft threshold the station drops to the pool and mutes optional segments; at
          the cap it stops calling the model at all and coasts on the fallback playlist.
          The music never stops. The switch is under Settings &rarr; LLM &rarr; Agentic
          picker; the model side is on{' '}
          <Link href="/manual/llm" className="bs-link">Models &amp; Tokens</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">TWO KINDS OF GROUPING</p>
        <h2>Playlists vs shows.</h2>
        <p>
          They sound like alternatives. They&rsquo;re layers &mdash; and a show can{' '}
          <em>use</em> playlists.
        </p>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th></th>
              <th>Playlist</th>
              <th>Show</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>What it is</strong></td>
              <td>A named set of tracks</td>
              <td>A block of programming on the schedule</td>
            </tr>
            <tr>
              <td><strong>Lives in</strong></td>
              <td>Navidrome</td>
              <td>The station&rsquo;s own schedule</td>
            </tr>
            <tr>
              <td><strong>Has a time</strong></td>
              <td>No</td>
              <td>Yes &mdash; that&rsquo;s the point</td>
            </tr>
            <tr>
              <td><strong>Has a persona, theme, topic</strong></td>
              <td>No</td>
              <td>Yes</td>
            </tr>
          </tbody>
        </table>
        <p>
          A <strong>playlist</strong>{' '}is just tracks. Build one by hand in Navidrome, or
          describe what you want (&ldquo;late-night driving, mostly instrumental, ninety
          minutes&rdquo;) and let the playlist builder assemble it from the same mood,
          vector and similarity machinery the DJ picks with, then order it into an energy
          arc.
        </p>
        <p>
          A <strong>show</strong>{' '}is an hour or more with an identity: which persona is on
          the mic, which skin the player wears, what the show is about, and a set of music
          filters &mdash; moods, genres, eras, energies, vocals. The DJ still picks every
          track live; the show narrows what it may pick from.
        </p>
        <p>
          Where they meet: a show can be <strong>anchored</strong>{' '}to one or more
          playlists. Anchored on its own makes the playlists the show&rsquo;s dominant
          source while leaving the DJ free to reach outside for a better fit. Anchored
          with <strong>strict</strong>{' '}on makes them the show&rsquo;s entire universe, and
          everything off-playlist is dropped before the DJ ever sees it.
        </p>
        <p className="text-muted">
          If a show pins playlists that no longer resolve &mdash; deleted and recreated in
          Navidrome, so the id moved &mdash; the anchor is ignored and the station says so
          in the log, including that the strict toggle had no effect. The show still airs;
          it just airs unanchored. Re-select the playlists in the show editor to fix it.
          Rule of thumb: recurring identity at a fixed hour is a <em>show</em>; a set of
          tracks you want to reach for is a <em>playlist</em>; &ldquo;this hour, only
          these tracks&rdquo; is a show anchored to a playlist with strict on.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">DISK FOR SEAMS</p>
        <h2>The stem cache, and what it buys.</h2>
        <p>
          A stem-blend transition mixes two tracks <em>by instrument</em>{' '}rather than
          fading two finished mixes together: the outgoing drums duck out under the
          incoming bass, and the vocals clear before the new vocal enters. Doing that
          needs the four separated stems &mdash; drums, bass, other, vocals &mdash; for
          both sides of the seam.
        </p>
        <p>
          Separating them takes far longer than the gap between two songs, so it
          can&rsquo;t happen at the seam. The analyzer does it during{' '}
          <Link href="/manual/analysis" className="bs-link">acoustic analysis</Link>{' '}
          instead, keeping the first forty seconds and the last twenty of each track. A
          transition is then a fast mix of files already on disk.
        </p>
        <p>
          Which makes the trade a simple one: <strong>the cost is disk, and only
          disk</strong>. The separation is paid for during analysis whether you keep the
          output or not. Budget 13&ndash;25&nbsp;MB per track; the default 15&nbsp;GB
          budget holds somewhere between six hundred and twelve hundred of them, and an
          LRU sweep evicts the least recently used once you&rsquo;re over.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE PART THAT SURPRISES PEOPLE</div>
          <p>
            A blend needs stems on <strong>both</strong>{' '}tracks of a pair. With half your
            library cached, far fewer than half your seams will blend &mdash; most fall
            back to a plain crossfade, which isn&rsquo;t a failure, just the ordinary
            behaviour. So the reason to raise the budget is coverage of <em>pairs</em>,
            not coverage of tracks. DJ Doc says this outright, with the track count your
            current budget actually holds.
          </p>
        </div>
        <p className="text-muted">
          Small library? Raise the budget until it covers the lot and let the analysis
          pass backfill. Tens of thousands of tracks? The budget will always bind, and
          blends land wherever the cache happens to be warm. Short on disk? Turn the cache
          off &mdash; every seam becomes a crossfade and nothing else changes. The dial is
          under Settings &rarr; Transitions.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">TWO LOCKS, ONE PASSWORD</p>
        <h2>Private player vs stream password.</h2>
        <p>
          These get confused because turning either one on asks for the same station
          password. They are independent, and only one of them actually stops anyone
          listening.
        </p>
        <p>
          The <strong>private player</strong> swaps the public pages for a password
          prompt. It hides the <em>interface</em>. The now-playing endpoints stay public
          &mdash; the player and the admin dash need them &mdash; and anyone who knows the
          stream address can still tune in. It applies live, with no restart.
        </p>
        <p>
          The <strong>stream password</strong> turns on listener authentication at Icecast
          itself, on every mount. That is the real boundary: without the password, there
          is no audio. Turning it on or off needs a mixer restart; changing the password
          applies live.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE SHORT VERSION</div>
          <p>
            The private player is a curtain. The stream password is a lock. Most people
            who want a private station want both, so that one prompt unlocks the page and
            the audio together.
          </p>
        </div>
        <p className="text-muted">
          A third thing is often mistaken for these two: HTTP Basic Auth applied in front
          of the whole station at your own reverse proxy. That isn&rsquo;t a SUB/WAVE
          feature and it behaves differently, particularly for the mobile apps. Both locks
          live under Settings &rarr; Station &rarr; Privacy; tuning in from VLC, Sonos,
          hardware radios and the apps once a password is on is covered on{' '}
          <Link href="/manual/clients" className="bs-link">Listen With</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE SHAPE OF THE DAY</p>
        <h2>Dayparts don&rsquo;t move with the sun.</h2>
        <p>
          The station divides the day into eight named periods, on fixed wall-clock hours
          in your station&rsquo;s timezone.
        </p>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Hours</th>
            </tr>
          </thead>
          <tbody>
            {DAYPARTS.map((d) => (
              <tr key={d.period}>
                <td><code>{d.period}</code></td>
                <td>{d.hours}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          These boundaries are not derived from sunrise or sunset, and they aren&rsquo;t
          configurable. Which reads oddly above about 55&deg; north or south, where
          &ldquo;evening&rdquo; is full daylight in June and pitch dark in December.
        </p>
        <p>
          It&rsquo;s a deliberate trade. A daypart is a <em>programming</em>{' '}idea &mdash;
          drive-time means the end of the working day, which is five o&rsquo;clock
          whatever the sky is doing &mdash; and it has to be predictable, because the
          schedule, the mood plan and the show grid are all built against named hours.
          Boundaries that drifted three hours across the year would quietly move your
          shows with them.
        </p>
        <p>
          What <em>is</em>{' '}sun-aware is the DJ&rsquo;s description of the world outside.
          The station reads whether the sun is currently up at your coordinates and puts
          that on the prompt, which is what stops it describing dusk two hours after dark
          in December, or &ldquo;the last of the light&rdquo; at nine in the evening in
          June. That runs off real solar position, so it&rsquo;s right at any latitude.
        </p>
        <p className="text-muted">
          So the lever at high latitude isn&rsquo;t moving the boundary, it&rsquo;s
          retuning what happens inside it: each period&rsquo;s <strong>mood</strong>{' '}is
          yours to set, under Moods &rarr; Moments. Give a Nordic summer evening a
          brighter mood than the default wind-down and let the sun-aware flag keep the
          DJ&rsquo;s language honest. Two nudges sit on top of the table and aren&rsquo;t
          editable: the small hours pull the speaking pace down whatever period the hour
          formally belongs to, and commute windows push it up. A show with a pinned energy
          overrides both.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">LISTENER SIGNAL</p>
        <h2>What a heart actually does.</h2>
        <p>
          There are two hearts and they aren&rsquo;t the same signal. The{' '}
          <strong>listener heart</strong> on the player is one like per apparent listener
          per <em>airing</em> &mdash; the same song aired again later can be liked again.
          Listeners have no accounts, so &ldquo;apparent listener&rdquo; is a one-way hash
          of the address; the raw address is never stored and everyone behind one router
          shares a key. It&rsquo;s lightweight de-duplication, not identity. The{' '}
          <strong>operator heart</strong> in the admin library is something else:
          curation, not a taste snapshot.
        </p>
        <p>
          By default a like changes <strong>nothing</strong>{' '}about rotation. It&rsquo;s
          recorded, it shows up in stats, and the track gets starred in Navidrome if
          you&rsquo;ve left that on. The DJ never hears about it.
        </p>
        <p>
          Influence is opt-in, under Settings &rarr; Likes. Turned on, the most-liked
          tracks become one more source feeding the candidate pool, capped like every
          other source &mdash; a weighted preference, never a lock, so the crowd can steer
          the pool without taking it over. Out of the box that means the ten most-liked
          tracks of the last thirty days; both numbers are yours to change, and a window
          of zero means all time.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">WHY THE TWO HEARTS AGE DIFFERENTLY</div>
          <p>
            An operator heart never expires from that window. A listener like ageing out
            is a taste snapshot going stale, which is right. An operator like ageing out
            would be the DJ forgetting curation you set by hand, which isn&rsquo;t.
          </p>
        </div>
        <p className="text-muted">
          Clearing them: from any row in{' '}
          <Link href="/admin/library" className="bs-link">the admin library</Link>,{' '}
          <strong>un-heart</strong> removes your own heart and leaves listener likes
          alone, while <strong>clear likes</strong> removes both. If yours was the last
          like standing and Navidrome starring is on, the track is unstarred there too.
        </p>
      </section>
    </ManualPage>
  );
}
