import { Fragment } from 'react';
import EditorialReveal from '../landing/EditorialReveal';

const BOXES = [
  { label: 'CONTROLLER', tone: 'default', note: 'node.js' },
  { label: 'DJ BRAIN', tone: 'accent', note: 'llm' },
  { label: 'LIQUIDSOAP', tone: 'default', note: 'mixer' },
  { label: 'ICECAST', tone: 'default', note: 'one stream' },
];

export default function UnderTheHood() {
  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">PART SIX · UNDER THE HOOD</p>
      <h2>Four processes, one box, one stream out.</h2>

      <div className="bs-drop-cap max-w-[64ch] text-[15px] leading-[1.6]">
        SUB/WAVE is not a cloud service. The whole stack (Icecast, Liquidsoap,
        the Controller, the LLM, the voice engines, and a Caddy edge) runs on a
        single machine in someone’s home, behind Cloudflare. The Controller is a
        small Node.js process that decides what plays and what gets said.
        Liquidsoap mixes the music, crossfades the tracks, ducks the DJ’s voice
        over the bed, and rotates the jingles. Icecast pushes the one stream out
        to every browser. The pieces talk through plain files in a shared folder.
        No socket, no message queue, the Unix way.
      </div>

      <div className="bs-flow">
        {BOXES.map((b, i) => (
          <Fragment key={b.label}>
            <div
              className="bs-box"
              data-tone={b.tone === 'accent' ? 'accent' : undefined}
            >
              {b.label}
              <div className="mt-1 text-[9px] font-medium tracking-[0.18em] text-muted lowercase">
                {b.note}
              </div>
            </div>
            {i < BOXES.length - 1 && <div className="bs-arrow">⟶</div>}
          </Fragment>
        ))}
      </div>

      <p className="mt-6 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
        No subscriptions, no round-trip to a data center, no algorithm tuned to
        keep you scrolling. The whole source is open, so you can run your own
        with a different DJ persona, a different library, and a different city
        on the dateline.
      </p>

      <div className="mt-8">
        <div
          className="bs-dj-glyph mx-auto mb-4 !w-[140px] sm:float-right sm:mx-0 sm:my-[2px] sm:mb-2 sm:ml-[14px] sm:!w-[190px]"
          aria-hidden="true"
        >
          <div className="bs-dj-vinyl" />
        </div>

        <p className="m-0 text-[16px] leading-[1.6]">
          Streaming apps gave everyone their own private channel. A playlist tuned
          to you, shuffled for you, paused the second you look away. SUB/WAVE goes
          the other direction entirely. It is one Icecast stream, a single
          broadcast every listener hears at the same moment, picked, announced,
          and mixed by software running on a single box in someone&apos;s home.
          No skip button. No &ldquo;for you.&rdquo; You tune in, and you hear
          whatever is on the air right now, the same as everyone else.
        </p>
      </div>
    </EditorialReveal>
  );
}
