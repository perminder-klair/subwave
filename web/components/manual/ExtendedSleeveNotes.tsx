import Link from 'next/link';
import ManualPage from './ManualPage';

export default function ExtendedSleeveNotes() {
  return (
    <ManualPage
      eyebrow="MANUAL · 17"
      title="Extended Sleeve Notes."
      intro="Give your DJ stories to tell about the music you play. Extended Sleeve Notes gathers background, credits and musical connections, saves the sources, and makes that research available for on-air links and conversations."
      current="/manual/sleeve-notes"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">BEHIND THE MUSIC</p>
        <h2>Give the DJ more to talk about.</h2>
        <p>
          Your DJ already uses track details, its persona and the LLM&rsquo;s general
          knowledge to write links. That knowledge can be broad, but it may miss a
          lesser-known artist, confuse two recordings or return to the same familiar
          observation whenever a song comes round.
        </p>
        <p>
          Extended Sleeve Notes gives it something more specific to work with: saved
          research about the music in your library, with sources you can check.
          That might be how an album came together, who produced a recording or which
          older record a track sampled. The model still writes in the DJ&rsquo;s own
          voice; the research gives it a reason to say something particular about
          this record. It can also give co-hosts a shared subject to explore.
        </p>
        <div className="bs-callout">
          <p className="bs-eyebrow">WHAT YOU MIGHT HEAR</p>
          <p>
            These invented examples show how saved research could shape a link.
            They illustrate the idea; they are not facts about particular records
            or scripts your DJ is guaranteed to use.
          </p>
          <ul className="bs-list">
            <li><strong>A recording story:</strong> A saved studio detail could turn a general introduction such as &ldquo;Another classic from the band&rdquo; into &ldquo;They kept the first take of that piano part. You can hear why &mdash; it has a lovely looseness to it.&rdquo;</li>
            <li><strong>A sample connection:</strong> If research connects two recordings, the DJ might say: &ldquo;That guitar phrase started life on a soul record. Listen to how it has been reshaped here.&rdquo;</li>
            <li><strong>A shared producer:</strong> A saved credit could start a conversation: &ldquo;We heard another of this producer&rsquo;s records earlier. What do you make of the drums on this one?&rdquo; Mentioning an earlier play also needs the station&rsquo;s record of what actually aired.</li>
          </ul>
        </div>
        <p>
          The aim is a DJ with more to notice and talk about, from a brief detail
          between songs to a longer conversation. Research gives it material beyond
          what the model happens to remember; it does not replace the model or make
          every statement correct. You can inspect the saved material and its sources
          in the admin console. The feature is optional, and your station can keep
          playing and talking without it.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SWITCHING IT ON</p>
        <h2>Start with the LLM your station already uses.</h2>
        <ol className="bs-list">
          <li>Sign in to the admin console and open <strong>Settings &rarr; DJ Behaviour</strong>.</li>
          <li>Enable <strong>Extended Sleeve Notes</strong> and save the setting.</li>
          <li>Open <strong>Notes</strong> in the admin navigation. Its Overview shows research activity and saved knowledge.</li>
          <li>In the Notes <strong>Settings</strong> tab, check collection preferences and optionally configure Genius access for credits and musical connections. Choose <strong>Save Sleeve Notes settings</strong> to apply your changes, or <strong>Discard</strong> to keep the saved values. MusicBrainz Lists has its own Save and Discard controls.</li>
          <li>Let the station play. Return later to see what it has learned.</li>
        </ol>
        <p>
          Research uses SUB/WAVE&rsquo;s configured LLM. A paid service is not required:
          a local model can do the work too. For a local model, allow for the additional
          processing load and time needed alongside its ordinary DJ work.
        </p>
        <div className="bs-callout">
          <p className="bs-eyebrow">IF YOU PAY BY THE TOKEN</p>
          <p>
            Allow roughly <strong>2,000 additional tokens per track played</strong> for
            background research. This is an estimate, not a fixed charge or limit:
            source material and research activity vary, and reviews and on-air segments
            add further usage. Check your station&rsquo;s usage and budget controls;
            the <Link href="/manual/llm" className="bs-link">Models &amp; Tokens</Link> guide
            explains the wider trade-offs.
          </p>
        </div>
        <p>
          Switching the master setting off hides the Notes workspace, Dash card and
          manual segment control, and stops new feature activity. Saved knowledge and
          queued jobs are retained for when you enable it again. Speech already handed to the broadcast is allowed to finish.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE FIRST FEW PLAYS</p>
        <h2>What to expect after enabling the feature.</h2>
        <p>
          An empty collection is a normal starting point. Let your station play:
          as it encounters artists and albums, SUB/WAVE gathers source material and
          queues it for the LLM to turn into stories. The <strong>LLM Research</strong>{' '}
          queue in Notes Overview may grow at first, especially while the station
          plays a succession of artists it has not researched before. A growing
          queue does not, on its own, mean something is wrong.
        </p>
        <p>
          As those artists come round for a second or later play, their saved research
          can be reused. There is less new work to add, giving the waiting research
          time to catch up. The queue should generally shrink and can reach zero
          once collection has caught up. New artists, different albums, refreshes and
          flagged reviews can add work again; the pace also depends on your model,
          available sources and how much time the broadcast leaves for research.
        </p>
        <p>
          A DJ link may already have been written by the time new stories arrive.
          That material is still useful to you: the Dash&rsquo;s <strong>Sleeve Notes</strong>{' '}
          ticker starts filling with saved facts as they become available, so you can
          read about the music while it plays even if the DJ did not mention the story.
          Saved facts are also available in Notes for you to inspect.
        </p>
        <p>
          Once enough suitable material is saved, a Sleeve Notes segment can become
          eligible for a scheduled speaking opportunity. Research finishing does not
          trigger speech immediately: the usual timing, settings and repetition checks
          still apply. You do not need to wait for the whole queue to clear before
          stories can be used on air.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">BACKGROUND RESEARCH</p>
        <h2>A collection that grows with your library.</h2>
        <p>
          Research starts from music the station encounters and also works through
          library tracks it has not researched yet when the station has time. MusicBrainz helps identify
          artists and releases; Wikipedia supplies artist and album background; optional
          Genius research adds recording credits, sample relationships and other music
          context. Coverage depends on what those sources contain and which sources you
          have enabled.
        </p>
        <p>
          Connections can also introduce you to artists outside your library. In
          <strong> Station Brain &rarr; Stats &amp; Discoveries</strong>, the
          <strong> Most connected</strong> list highlights outside artists who have
          links to several different artists you already play. It is a starting point
          for exploring music you might want to add to your library in future.
          Lyrics are not collected or used as Sleeve Notes material.
        </p>
        <p>
          MusicBrainz lists change slowly, so Subwave normally checks them once a
          month. After matching the library, this work settles down. New or changed
          albums and changes to your enabled lists can give it more to do.
        </p>
        <p>
          Full Wikipedia articles are kept while research is in progress and become
          eligible for cleanup a day after the scan finishes successfully. Saved facts,
          supporting passages, nearby context and source links are kept. Pending
          research, reviews or a cleanup backlog can keep an article for longer. A later refresh may
          need to fetch the article again before research can continue.
        </p>
        <p>
          Broadcast work takes priority. Research waits while the station is busy
          choosing tracks or preparing speech. Provider
          limits, temporary failures and the station&rsquo;s token budget can also make
          it wait. The Overview separates <strong>Controller Research</strong>, which
          collects and connects information, from <strong>LLM Research</strong>, which
          turns source material into usable talking points and handles reviews.
        </p>
        <p>
          Expand <strong>Show queue</strong> in the Overview&rsquo;s Research activity
          box to use <strong>Send to top</strong> or <strong>Cancel job</strong>.
          Prioritising moves eligible work ahead in its worker queue; it still waits
          for broadcast work, source limits, retry delays and any required play.
          Reviews and background research share LLM slots so neither waits for the entire other queue.
          Running jobs finish their current step before these controls become available.
          Cancelling keeps saved facts and progress. Automatic collection or a later
          request may queue research again; cancelling a queued review dismisses it.
        </p>
        <p>
          Check <strong>Research while the station is empty</strong> in Notes settings
          if you want collection without listeners; other station settings still affect
          when work can run. Leave collection time to build useful coverage; some
          artists will have more source material than others.
        </p>
        <p>
          To stop collecting while keeping saved knowledge available to the DJ, choose
          <strong> Pause collection</strong> in Notes settings, then save. This keeps queued work
          for later. It is different from turning the master switch off, which also
          stops the feature&rsquo;s on-air use and hides its interface.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">RESEARCH PACE</p>
        <h2>Can I speed research up?</h2>
        <p>
          Research is deliberately paced. MusicBrainz, Wikipedia and Genius are shared
          services: SUB/WAVE needs to respect their API request limits and bandwidth.
          Sending more requests at once can lead to throttling or temporary blocks,
          making collection slower rather than faster.
        </p>
        <p>
          Your broadcast also comes first. Research waits while SUB/WAVE chooses
          tracks, prepares speech or handles other work needed to keep the station
          running smoothly. A faster LLM may finish an individual research task sooner,
          but it does not remove source limits or give research priority over the
          broadcast. Increasing the token budget will not bypass those safeguards.
        </p>
        <p>
          To give collection more opportunities, keep the station running, check that
          collection is not paused and, if it suits your setup, enable
          <strong> Research while the station is empty</strong>. Other station settings
          and your token budget still apply. The Overview shows why work is waiting.
          Let the queue build your collection gradually; there is no need to research
          the whole library before the DJ can use the stories already saved.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">FINDING YOUR WAY AROUND</p>
        <h2>What is a Story Spark?</h2>
        <ul className="bs-list">
          <li><strong>Stories</strong> are researched talking points about artists, albums or tracks: an anecdote, a recording detail or a notable achievement.</li>
          <li><strong>Connections</strong> describe musical relationships, such as one recording sampling or covering another.</li>
          <li><strong>Credits</strong> identify contributions such as writing, production or a featured performance.</li>
          <li><strong>A Story Spark</strong> is a saved fact offered to the DJ as something it could mention. The DJ may weave it into its own words or leave it out.</li>
          <li><strong>A source</strong> is the supporting reference behind the material. Follow it when you want to understand or check a claim.</li>
        </ul>
        <p>
          On Overview, <strong>Library connections</strong> counts unique sample and
          cover relationships between recordings matched to your current library.
          Seeing the same relationship from both recordings counts once. The
          Library connections and Credits numbers open Station Brain. In Station Brain&rsquo;s
          <strong> Stats &amp; Discoveries</strong>, <strong>All saved relationships</strong>{' '}
          includes the wider collection, with recordings outside your library and
          facts saved from either direction. Shared writers and producers stay
          under Credits.
        </p>
        <p>
          Use the <strong>Stories</strong> tab to browse saved facts, recent additions
          and material associated with your library. Saved does not mean aired, and
          offered does not mean spoken. A source gives you something to check; it does
          not make every interpretation or piece of wording infallible.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ON THE MICROPHONE</p>
        <h2>A passing remark, or a conversation.</h2>
        <p>
          In an ordinary spoken link, the DJ can receive a relevant saved Spark and
          turn it into a natural remark. It may leave the Spark out when the timing or
          subject does not fit. The station does not wait for fresh research before it
          can speak: without suitable saved material, the normal link still works.
        </p>
        <p>
          A dedicated <strong>Sleeve Notes segment</strong> gives the material more room.
          When the schedule calls for automatic Banter, SUB/WAVE first tries Sleeve
          Notes if there is enough suitable material. This also applies during
          Produced Episodes. Otherwise, it uses ordinary Banter. Choosing Banter
          yourself still requests Banter.
        </p>
        <p>
          Use the manual Sleeve Notes segment control on the Dash when you want to
          request one yourself, and check Notes settings for segment controls. A manual
          request still needs suitable saved material and safe broadcast timing; it
          cannot create a researched conversation from an empty collection.
        </p>
        <p>
          The DJ spaces out repeated stories, topics and connections, so a saved story
          may wait for a suitable moment. After a story from a MusicBrainz series
          (such as a curated list of notable albums) is detected in aired speech,
          other stories from that series wait six hours. A manual segment can reuse
          aired stories without waiting for these cooldowns.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">STATION BRAIN</p>
        <p>
          Overview explains why research is waiting and shows when a source was last
          collected and research last completed. Normal broadcast, listener and source
          limits can pause progress. Use <strong>Inspect storage</strong> to see a
          snapshot of database space and retained text by source; it runs only when
          requested, and a later inspection can show how the file has grown.
        </p>
        <h2>Follow the connections yourself.</h2>
        <p>
          Open <strong>Station Brain</strong> in Notes and search for an artist, album
          or track. The <strong>Map</strong> view lets you move through those layers,
          select an item and inspect its saved knowledge and relationships. Fullscreen
          gives a larger graph more room. An item can appear on the map before any stories have been saved about it.
          Its details panel may therefore have little to show at first.
        </p>
        <p>
          The map follows your selected theme while keeping its relationship colours
          distinct. Click the <strong>Layout</strong>, <strong>Map controls</strong> or
          <strong> Key</strong> heading to fold that group away and give the map more
          room. Desktop choices are remembered in this browser. On a phone, these
          groups start closed and open when you tap their heading.
        </p>
        <p>
          Artist, album and track links in the Overview&rsquo;s On Air and Next Up
          panels take you into the relevant library context. Where queue controls are
          available, you can queue music from your library as an operator action.
          An external discovery is a reference to music or an artist beyond the library,
          not a promise that the station can play it.
        </p>
        <p>
          Switch to <strong>Stats &amp; Discoveries</strong> for a broader view of the
          saved network. <strong>Most connected</strong> highlights external names
          linked to several different artists in your library; <strong>Sample sources</strong> and
          <strong> Sample users</strong> explore the two directions of sample relationships.
          These views use saved research. Use Refresh to update the view as the
          collection grows; opening it does not launch a new external search.
        </p>
        <p>
          Genius is optional. With capture off, you can still browse your library,
          read Wikipedia stories and queue music. New sample, cover and contributor
          connections are not collected, so discovery lists may be empty on a fresh
          station. Previously saved connections remain visible. Station Brain shows
          whether capture is off or needs an API key, with a link to Notes Settings.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ON THE DASH</p>
        <h2>A little reading while the records play.</h2>
        <p>
          The Dash gains a rotating <strong>Sleeve Notes</strong> card showing saved
          material. Its text reveals gradually; hovering over the card or focusing
          inside it completes the reveal and pauses rotation so you can finish reading.
          The Station Brain header link opens the current on-air library artist.
        </p>
        <p>
          Reading a card does not make the DJ say it, request a segment or count
          the story as used on air. If a saved Spark needs attention, use its review flag.
          Connections and credits do not carry that same card-level flag.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">HEARD ON AIR</p>
        <h2>See what the DJ actually said.</h2>
        <p>
          Open <strong>Heard on air</strong> in Notes to read confirmed aired exchanges
          and their transcripts. The default Sleeve Notes view includes confirmed
          dedicated segments and ordinary links where Spark use was detected. The
          Overview also shows recent exchanges from that view.
        </p>
        <p>
          SUB/WAVE records whether a segment aired and separately checks whether its
          words used a saved Spark. The DJ can paraphrase a fact in a way the detector misses.
          Use the <strong>Use detected</strong>, <strong>Use not detected</strong> and
          <strong> All aired exchanges</strong> filters to investigate. An ordinary
          greeting that was offered a Spark but did not use it is not automatically a
          Sleeve Notes exchange in the default view.
        </p>
        <p>
          Flag an exchange when its spoken content needs review. Flag the saved fact instead if the research itself is wrong.
          This helps you address the source of the problem. Correcting saved material does not rewrite the historical
          transcript of what aired.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">YOUR EDITORIAL CHOICES</p>
        <h2>Shape the research and the voice.</h2>
        <p>
          Research instructions decide what is worth saving; persona direction and
          house rules shape how the DJ talks about it. In Notes settings, the advanced
          Wikipedia research prompt lets you steer the kinds of facts extracted from
          articles. Its preview tests draft instructions against cached source material
          without saving new facts. Preview and review work can still use LLM tokens.
        </p>
        <p>
          Changing research instructions is not a rewrite of everything already saved.
          Browse existing material in Stories and use the available correction,
          withdrawal and review controls where needed. The <strong>Review</strong> tab
          lets you inspect findings and decide which proposed changes to apply. A flag
          asks for attention; it is not itself a published correction. If no replacement
          wording is suggested, choose <strong>Edit saved fact</strong> to write your
          own correction. Keep the supporting passage as an exact excerpt from the
          saved source, then explicitly save the correction to apply it.
        </p>
        <p>
          You can change what the DJ knows and how it sounds separately. Asking for warmer,
          shorter or less formal speech changes presentation; it does not supply
          evidence for a new claim. Inspect the supporting source when the underlying
          fact is in doubt. See <Link href="/manual/dj" className="bs-link">How the DJ Works</Link>
          {' '}for personas and <Link href="/manual/admin" className="bs-link">Admin &amp; Settings</Link>
          {' '}for the wider station controls.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHEN SOMETHING LOOKS QUIET</p>
        <h2>What to check first.</h2>
        <ul className="bs-list">
          <li><strong>Notes has disappeared.</strong> Check the master switch in Settings &rarr; DJ Behaviour. The workspace is hidden while the feature is off; saved data is retained.</li>
          <li><strong>Research is waiting.</strong> Check Overview for collection pause, budget or activity messages, then check empty-station preferences and source configuration.</li>
          <li><strong>An artist has little material.</strong> Research may not have reached them, a source may have no useful coverage, or the identity may be ambiguous. Try other library items and inspect the saved sources.</li>
          <li><strong>A saved story has not aired.</strong> Relevance, speaking opportunities and cooldowns all affect selection. A Spark can also be offered and left unused.</li>
          <li><strong>A discovery cannot be queued.</strong> It may describe music outside your library. Research does not make that recording playable.</li>
          <li><strong>A segment aired but use was not detected.</strong> Read its transcript. Wording detection is a useful signal, not a complete account of every paraphrase.</li>
        </ul>
        <p>
          Start with the defaults and a few familiar artists. Check the sources, listen
          to how the DJ uses them, and adjust the editorial instructions once you know
          what suits your station. Research coverage and on-air opportunities vary;
          the collection becomes more useful as it grows.
        </p>
      </section>
    </ManualPage>
  );
}
