import Link from 'next/link';
import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

const PATHS = [
  {
    href: '/setup/quick-start',
    label: 'Quick Start',
    blurb: 'The standalone CLI — install once, init / setup / start, done.',
  },
  {
    href: '/setup/manual',
    label: 'Manual Install',
    blurb: 'No CLI on your host — pure docker compose, same outcome.',
  },
  {
    href: '/setup/development',
    label: 'Development',
    blurb: 'Hacking on SUB/WAVE itself — the three compose files and hot reload.',
  },
];

export default function SetupOverview() {
  return (
    <SetupPage
      eyebrow="SELF-HOSTED · OPEN SOURCE"
      title="Run your own SUB/WAVE."
      meta="≈ 10 min · 4 commands · needs Navidrome + an LLM"
      intro="SUB/WAVE points at your Navidrome library and your LLM: a local Ollama box by default, or any hosted provider you prefer. Once it's running, the AI DJ broadcasts from your homelab, plays from your music collection, and answers requests from anyone with the URL."
      current="/setup"
      heroAside={
        <div className="bs-dj-glyph" aria-hidden="true">
          <div className="bs-dj-vinyl" />
        </div>
      }
    >
      <section className="bs-section">
        <div className="bs-faststart">
          <p className="bs-eyebrow">THE FAST PATH</p>
          <p>
            Already have Docker, Navidrome, and an LLM reachable? One curl, two
            Enters, and the station is on the air. The installer chains
            straight into <code className="bs-code-inline">init</code> and{' '}
            <code className="bs-code-inline">start</code>, then{' '}
            <code className="bs-code-inline">setup</code> finishes the configuration.
          </p>
          <CodeBlock>{`curl -fsSL https://cli.getsubwave.com | sh`}</CodeBlock>
          <CodeBlock>{`subwave setup`}</CodeBlock>
          <p className="text-muted">
            The installer drops the <code className="bs-code-inline">subwave</code>{' '}
            binary, then prompts <em>Run subwave init now?</em> Say yes and it
            walks the install dir (default{' '}
            <code className="bs-code-inline">~/subwave</code>), deployment shape
            (prod / prod-byo), and admin credentials.{' '}
            <code className="bs-code-inline">init</code> ends with{' '}
            <em>Bring the stack up now?</em> Yes again brings up Docker. Then{' '}
            <code className="bs-code-inline">setup</code> prompts for Navidrome
            and your LLM, persists everything, and renders the station jingles.{' '}
            <Link href="/setup/quick-start" className="bs-link">
              Full walkthrough →
            </Link>
          </p>
          <p className="text-muted">
            After that,{' '}
            <code className="bs-code-inline">subwave status / logs / doctor / restart / update</code>{' '}
            drive the station from anywhere on your shell, with no{' '}
            <code className="bs-code-inline">cd</code> into a project dir, no clone
            required. Prefer pure <code className="bs-code-inline">docker compose</code>?{' '}
            <Link href="/setup/manual" className="bs-link">Manual Install</Link>{' '}
            covers that path.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">IF YOU'RE NEW HERE</p>
        <h2>Start at Prerequisites.</h2>
        <p>
          SUB/WAVE talks to services it doesn't ship, so a couple of things need
          to be running first.{' '}
          <Link href="/setup/prerequisites" className="bs-link">Prerequisites</Link>{' '}
          covers them, then pick whichever install path suits you — they all land
          at the same place:
        </p>
        <ul className="bs-list">
          {PATHS.map((p) => (
            <li key={p.href}>
              <Link href={p.href} className="bs-link">
                <strong>{p.label}</strong>
              </Link>{' '}
              — {p.blurb}
            </li>
          ))}
        </ul>
        <p>
          Just want to <em>listen</em> to a station, not run one?{' '}
          <Link href="/manual" className="bs-link">The manual</Link> covers tuning
          in and making requests.
        </p>
      </section>
    </SetupPage>
  );
}
