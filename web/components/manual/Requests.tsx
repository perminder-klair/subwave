import ManualPage from './ManualPage';

export default function Requests() {
  return (
    <ManualPage
      eyebrow="MANUAL · 02"
      title="Making requests."
      intro="You can ask the DJ for something. Here's how to send a request, what the DJ does with it, and what to expect on air."
      current="/manual/requests"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">SEND IT</p>
        <h2>Open &ldquo;Make a request.&rdquo;</h2>
        <p>
          In the player, open the <strong>Make a request</strong> panel. Type what you
          want and, if you like, your name — so the DJ can give you a shout-out. You don't
          have to be precise: a song title, an artist, or a mood all work.
        </p>
        <ul className="bs-list">
          <li><strong>A track</strong> — &ldquo;play Just Like Heaven by The Cure.&rdquo;</li>
          <li><strong>An artist</strong> — &ldquo;something by Aphex Twin.&rdquo;</li>
          <li><strong>A mood</strong> — &ldquo;something for a rainy Sunday morning.&rdquo;</li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHAT HAPPENS NEXT</p>
        <h2>The DJ reads it, then digs through the crates.</h2>
        <p>
          Your request is accepted instantly, and the panel then waits for the outcome.
          Behind the desk, the AI DJ interprets what you asked for and searches the
          station's music library for the best match. If it finds one, it usually records
          a short spoken intro, acknowledging your request by name, and queues the track
          to play when the current song finishes.
        </p>
        <p>
          If nothing in the library fits, the DJ won't force it — you may get a different
          take on the mood you asked for instead. The station only plays what's actually
          in its collection.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">IT'S STILL A BROADCAST</p>
        <h2>Your request plays for everyone.</h2>
        <p>
          A request doesn't cut in front of the song that's already playing. There's no
          skip. It joins the broadcast as the next natural transition, and when it airs,
          <em> every</em> listener hears it, not just you. That's the point: it's one
          shared station, and you just put something on it.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">A FEW TIPS</div>
          <p>
            Be specific when you have a specific song in mind, and loose when you don't —
            the DJ handles both. Watch <strong>the booth</strong> panel to catch your
            shout-out, and the <strong>Timeline</strong> to see your track land in the
            queue.
          </p>
        </div>
      </section>
    </ManualPage>
  );
}
