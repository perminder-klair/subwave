import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

export default function QuickStart() {
  return (
    <SetupPage
      eyebrow="SETUP · 02"
      title="The easy way in."
      intro="Two hands-off paths to a running stack. The wizard asks a few questions and does the rest. The agent skill does the same from one sentence in your AI coding tool. Either way, the radio ends up on the air."
      current="/setup/quick-start"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">PATH A · STANDALONE CLI</p>
        <h2>One curl, two Enters, on the air.</h2>
        <p>
          Drops a <code className="bs-code-inline">subwave</code> binary on your
          host (no Node required), then chains straight into{' '}
          <code className="bs-code-inline">init</code> and{' '}
          <code className="bs-code-inline">start</code>. By the time the
          installer finishes, Docker is up and the controller reports on-air.
          That leaves <code className="bs-code-inline">setup</code>, which
          handles configuration rather than lifecycle.
        </p>
        <div className="bs-faststart">
          <p className="bs-eyebrow">TWO COMMANDS</p>
          <CodeBlock>{`curl -fsSL https://cli.getsubwave.com | sh`}</CodeBlock>
          <CodeBlock>{`subwave setup`}</CodeBlock>
          <p className="text-muted">
            The installer prompts <em>Run subwave init now?</em> Say yes and{' '}
            <code className="bs-code-inline">init</code> asks where to install
            (default <code className="bs-code-inline">~/subwave</code>),
            deployment shape (prod / prod-byo), and admin credentials. It ends
            with <em>Bring the stack up now?</em> Say yes again and{' '}
            <code className="bs-code-inline">subwave start</code> runs silently
            against the env <code className="bs-code-inline">init</code> just
            picked. After that,{' '}
            <code className="bs-code-inline">setup</code> asks for your Navidrome,
            LLM, and DJ persona settings and renders jingles. From then on,{' '}
            <code className="bs-code-inline">subwave start / stop / logs / doctor</code>{' '}
            run the station from anywhere on your shell.
          </p>
        </div>
        <div className="bs-devprod">
          <div>
            <p className="bs-eyebrow">DEV</p>
            <ul className="bs-list">
              <li>
                <code className="bs-code-inline">docker-compose.dev.yml</code>
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
                <code className="bs-code-inline">docker-compose.yml</code> with{' '}
                <code className="bs-code-inline">--build</code>
              </li>
              <li>
                Caddy on <code className="bs-code-inline">:7700</code>
              </li>
              <li>
                state in <code className="bs-code-inline">./state</code> (or{' '}
                <code className="bs-code-inline">STATE_DIR</code>); re-run with sudo
                if it isn't writable
              </li>
            </ul>
          </div>
        </div>
        <div className="bs-callout">
          <div className="bs-eyebrow">SAFE TO RE-RUN</div>
          <p>
            Existing env values stay put unless you ask to reconfigure, so the
            wizard also works for bringing an existing stack back up.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PATH B · AI CODING AGENT</p>
        <h2>One sentence in your coding agent.</h2>
        <p>
          The repo ships an agent skill that handles setup, deploy, and update. It pings
          Navidrome and Ollama, boots the stack, generates jingles, and checks that the stream is
          on-air. It works with <strong>Claude Code</strong>, <strong>Codex</strong>,{' '}
          <strong>Cursor</strong>, or anything else that reads{' '}
          <code className="bs-code-inline">AGENTS.md</code>.
        </p>
        <p>Clone the repo and open your agent in it:</p>
        <CodeBlock>{`git clone https://github.com/perminder-klair/subwave.git
cd subwave`}</CodeBlock>
        <p>
          Then ask your agent one of: <em>&ldquo;set up subwave&rdquo;</em>,{' '}
          <em>&ldquo;deploy subwave&rdquo;</em>, or{' '}
          <em>&ldquo;pull and restart&rdquo;</em>.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">WHY USE THE SKILL</div>
          <p>
            On updates the same skill works out which services actually changed and rebuilds
            only those. Liquidsoap and the Controller <em>COPY</em> their source at build
            time, so a plain <code className="bs-code-inline">docker compose restart</code>{' '}
            quietly runs stale code. The skill won&apos;t make that mistake.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ONCE IT'S ON THE AIR</p>
        <h2>Run the station from the CLI.</h2>
        <p>
          The setup wizard is one screen of the operator console. Run{' '}
          <code className="bs-code-inline">npm start</code> from the repo any time to open it.
          From the menu you can check the stack, run diagnostics, tail logs, restart a service,
          or open the terminal player.
        </p>
        <CodeBlock>{`npm start`}</CodeBlock>
        <div className="bs-callout">
          <div className="bs-eyebrow">LISTEN FROM THE TERMINAL</div>
          <p>
            The console&apos;s <strong>play</strong> option launches the TUI player: now-playing,
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
