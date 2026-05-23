import SetupPage from './SetupPage';
import CodeBlock from './CodeBlock';

export default function QuickStart() {
  return (
    <SetupPage
      eyebrow="SETUP · 02"
      title="The easy way in."
      intro="Two hands-off paths to a running stack. The interactive wizard asks a few questions and does the rest; the agent skill does the same from one sentence in your AI coding tool. Either one ends with the radio on the air."
      current="/setup/quick-start"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">PATH A · INTERACTIVE WIZARD</p>
        <h2>Answer a few questions, get a running stack.</h2>
        <p>
          A terminal wizard that writes the env files, brings up the right compose file, and
          renders the station jingles. Requires Node 20+ and Docker.
        </p>
        <div className="bs-faststart">
          <p className="bs-eyebrow">FOUR COMMANDS</p>
          <CodeBlock>{`git clone https://github.com/perminder-klair/subwave.git
cd subwave
npm install
npm run setup`}</CodeBlock>
          <p className="text-muted">
            Its first question is <em>dev, prod, or prod-byo?</em> Then it prompts
            for Navidrome and Ollama, runs{' '}
            <code className="bs-code-inline">scripts/setup.sh</code>, boots the
            stack, and generates jingles.
          </p>
        </div>
        <div className="bs-devprod">
          <div>
            <p className="bs-eyebrow">DEV</p>
            <ul className="bs-list">
              <li>
                <code className="bs-code-inline">docker-compose.yml</code>
              </li>
              <li>
                state in <code className="bs-code-inline">./state</code>
              </li>
              <li>
                optionally launches <code className="bs-code-inline">next dev</code> on{' '}
                <code className="bs-code-inline">:7700</code>
              </li>
            </ul>
          </div>
          <div>
            <p className="bs-eyebrow">PRODUCTION</p>
            <ul className="bs-list">
              <li>
                <code className="bs-code-inline">docker-compose.prod.yml</code> with{' '}
                <code className="bs-code-inline">--build</code>
              </li>
              <li>
                Caddy on <code className="bs-code-inline">:4800</code>
              </li>
              <li>
                state in <code className="bs-code-inline">./state</code> (or{' '}
                <code className="bs-code-inline">STATE_DIR</code>) — re-run with sudo
                if it isn't writable
              </li>
            </ul>
          </div>
          <div>
            <p className="bs-eyebrow">PROD (BYO PROXY)</p>
            <ul className="bs-list">
              <li>
                <code className="bs-code-inline">docker-compose.byo-proxy.yml</code> —
                no bundled Caddy
              </li>
              <li>
                services on <code className="bs-code-inline">:7700</code> /{' '}
                <code className="bs-code-inline">:7701</code> /{' '}
                <code className="bs-code-inline">:7702</code> for your Traefik / nginx
                / existing Caddy to front
              </li>
              <li>
                <code className="bs-code-inline">docker/Caddyfile</code> is the
                reference route table to replicate
              </li>
            </ul>
          </div>
        </div>
        <div className="bs-callout">
          <div className="bs-eyebrow">SAFE TO RE-RUN</div>
          <p>
            Existing env values are kept unless you explicitly ask to reconfigure — so the
            wizard doubles as a way to bring an existing stack back up.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PATH B · AI CODING AGENT</p>
        <h2>One sentence in your coding agent.</h2>
        <p>
          The repo ships an agent skill that handles setup, deploy, and update — it pings
          Navidrome and Ollama, boots the stack, generates jingles, and verifies the stream is
          on-air. It works with <strong>Claude Code</strong>, <strong>Codex</strong>,{' '}
          <strong>Cursor</strong>, or anything else that reads{' '}
          <code className="bs-code-inline">AGENTS.md</code>.
        </p>
        <p>Clone the repo, open your agent in it, and say one of:</p>
        <CodeBlock>{`git clone https://github.com/perminder-klair/subwave.git
cd subwave
# then in your agent of choice, ask:
# "set up subwave"
# "deploy subwave"
# "pull and restart"`}</CodeBlock>
        <div className="bs-callout">
          <div className="bs-eyebrow">WHY USE THE SKILL</div>
          <p>
            On updates the same skill detects which services actually changed and rebuilds
            only those. Liquidsoap and the Controller <em>COPY</em> their source at build
            time, so a plain <code className="bs-code-inline">docker compose restart</code>{' '}
            silently runs stale code — the skill won't make that mistake.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ONCE IT'S ON THE AIR</p>
        <h2>Run the station from the CLI.</h2>
        <p>
          The setup wizard is one screen of the operator console. Run{' '}
          <code className="bs-code-inline">npm start</code> from the repo any time to open it
          — a menu to check the stack, run a diagnostic sweep, tail logs, restart a service,
          or open the terminal player.
        </p>
        <CodeBlock>{`npm start`}</CodeBlock>
        <div className="bs-callout">
          <div className="bs-eyebrow">LISTEN FROM THE TERMINAL</div>
          <p>
            The console's <strong>play</strong> option launches the TUI player — now-playing,
            the timeline, the live booth feed, and track requests, right in your terminal. It
            needs <code className="bs-code-inline">mpv</code> or{' '}
            <code className="bs-code-inline">ffplay</code> for audio, and runs as a read-only
            dashboard without them.
          </p>
        </div>
      </section>
    </SetupPage>
  );
}
