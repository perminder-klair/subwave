import Link from 'next/link';
import ManualPage from './ManualPage';

const GUIDE = [
  {
    href: '/manual/getting-started',
    label: 'Getting Started',
    blurb: 'What SUB/WAVE is, how to tune in, and what every part of the player does.',
  },
  {
    href: '/manual/requests',
    label: 'Making Requests',
    blurb: 'Ask the DJ for a track, an artist, or just a mood — and what happens after you do.',
  },
  {
    href: '/manual/clients',
    label: 'Listen With',
    blurb: 'Tune in from the native apps, VLC, or any app that opens an internet-radio stream.',
  },
  {
    href: '/manual/shortcuts',
    label: 'Keyboard Shortcuts',
    blurb: 'Drive the whole player from the keyboard, plus the command palette.',
  },
  {
    href: '/manual/dj',
    label: 'How the DJ Works',
    blurb: 'The AI behind the desk: how it picks songs, when it talks, and who it sounds like.',
  },
  {
    href: '/manual/skills',
    label: 'Custom Skills',
    blurb: 'Add your own between-track segments — drop a SKILL.md into state/skills and the DJ can run it.',
  },
  {
    href: '/manual/admin',
    label: 'Admin & Settings',
    blurb: 'For the operator — signing in, tuning the DJ, scheduling shows, and managing jingles.',
  },
  {
    href: '/manual/themes',
    label: 'Themes',
    blurb: 'Pick the station-wide palette every listener sees, override it per show, or drop in your own.',
  },
  {
    href: '/manual/cli',
    label: 'The Operator CLI',
    blurb: 'Run the station from the terminal — a status-aware console for health, logs, restarts, and the players.',
  },
  {
    href: '/manual/llm',
    label: 'Models & Tokens',
    blurb: 'Tune the station for a small local model or a large hosted one — trading richness against token cost.',
  },
  {
    href: '/manual/mcp',
    label: 'Agent Access',
    blurb: 'Let an AI agent read the station, request tracks, and drive the DJ over the MCP server.',
  },
  {
    href: '/manual/faq',
    label: 'FAQ',
    blurb: 'Quick answers — empty rooms, small models, mood tagging, and the parts behind the DJ.',
  },
];

const NUMBER_WORDS = [
  'No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
];
const guideCount = NUMBER_WORDS[GUIDE.length] ?? String(GUIDE.length);

export default function Overview() {
  return (
    <ManualPage
      eyebrow="SUB/WAVE MANUAL"
      title="How to use SUB/WAVE."
      intro="SUB/WAVE is a personal internet radio station: one live stream that every listener hears at the same moment, with an AI DJ picking the tracks and talking between them. This manual covers both sides of the dial: tuning in as a listener, and running the station as its operator."
      current="/manual"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">WHAT'S INSIDE</p>
        <h2>{guideCount} short guides.</h2>
        <p>
          Start at the top if you're new. Each page links to the next, so you can read
          straight through, or jump to whatever you need from the contents on the left.
        </p>

        <ul className="bs-list">
          {GUIDE.map((g) => (
            <li key={g.href}>
              <Link href={g.href} className="bs-link">
                <strong>{g.label}</strong>
              </Link>{' '}
              — {g.blurb}
            </li>
          ))}
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE ONE THING TO KNOW</p>
        <h2>It's a broadcast, not a playlist.</h2>
        <p>
          Streaming apps give everyone a private channel: shuffled for you, paused the
          second you look away. SUB/WAVE goes the other way. There is one Icecast stream,
          and everyone hears whatever is on the air <em>right now</em>. There is no
          &ldquo;for you,&rdquo; and there is no skip button. You can ask for a song, but
          it joins the broadcast for every listener. It doesn't jump the current track.
        </p>
        <p>
          Want to run your own station instead of just listening?{' '}
          <Link href="/setup" className="bs-link">The setup guide</Link> walks through
          pointing SUB/WAVE at your own music library and LLM.
        </p>
      </section>
    </ManualPage>
  );
}
