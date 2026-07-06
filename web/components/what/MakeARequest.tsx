import Figure from './Figure';
import EditorialReveal from '../landing/EditorialReveal';

const STEPS = [
  {
    n: '01',
    title: 'Ask in plain language.',
    body:
      'Open the request drawer and type what you want: a song title, an artist, a vibe. No exact spelling, no library browsing. Add your name if you want the DJ to use it on air.',
  },
  {
    n: '02',
    title: 'Get an instant nod.',
    body:
      '“Got it — taking it to the booth.” The acknowledgement is immediate while the matching happens in the background, so the drawer never just sits there.',
  },
  {
    n: '03',
    title: 'The DJ finds the match.',
    body:
      'An LLM reads your request, searches the library, and picks the closest real track. Suggestion chips (built from the current artist, the time of day, the weather) give you a head start if you are undecided.',
  },
  {
    n: '04',
    title: 'It airs, with an intro.',
    body:
      'When the match lands, the drawer shows the track and the DJ’s spoken intro. Your request joins the one queue everyone is hearing, and the DJ may say your name as it goes out.',
  },
];

export default function MakeARequest() {
  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">PART FOUR · REQUESTS</p>
      <h2>Phone the station, like you used to.</h2>
      <p className="text-muted">
        Requests are the one place a listener steers the broadcast. And it
        works the way calling a radio station always should have.
      </p>

      <div className="bs-grid-split">
        <div className="flex flex-col gap-[18px]">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="grid grid-cols-[48px_1fr] items-baseline gap-[14px]"
            >
              <span className="text-[22px] font-extrabold tracking-[-0.02em] text-vermilion">
                {s.n}
              </span>
              <div>
                <h3 className="m-0 mb-[6px] text-[clamp(17px,1.8vw,21px)] leading-[1.2] font-extrabold tracking-[-0.02em]">
                  {s.title}
                </h3>
                <p className="m-0 text-[14px] leading-[1.55] text-muted">
                  {s.body}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="bs-column-rule" aria-hidden="true" />
        <div className="mx-auto max-w-[260px]">
          <Figure
            src="/screenshots/player-request-song.webp"
            alt="Player — Request a Song"
            label="Player — Request a Song"
            caption="The request drawer: type a song, get an instant ack, watch the match land."
            ratio="9 / 16"
            width={828}
            height={1792}
          />
        </div>
      </div>
    </EditorialReveal>
  );
}
