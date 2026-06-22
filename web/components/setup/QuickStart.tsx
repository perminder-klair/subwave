import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

export default function QuickStart() {
  return (
    <SetupPage
      eyebrow="SETUP · 02"
      title="The easy way in."
      intro="Two hands-off paths to a running stack. The interactive wizard asks a few questions and does the rest; the agent skill does the same from one sentence in your AI coding tool. Either one ends with the radio on the air."
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
          installer finishes, Docker is up and the controller is reporting
          on-air; <code className="bs-code-inline">setup</code> is the only
          step left, and it covers configuration, not lifecycle.
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
            <code className="bs-code-inline">setup</code> prompts for Navidrome +
            LLM + DJ persona and renders jingles. Then{' '}
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
            Existing env values are kept unless you explicitly ask to reconfigure, so the
            wizard doubles as a way to bring an existing stack back up.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PATH B · AI CODING AGENT</p>
        <h2>One sentence in your coding agent.</h2>
        <p>
          The repo ships an agent skill that handles setup, deploy, and update: it pings
          Navidrome and Ollama, boots the stack, generates jingles, and verifies the stream is
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
            On updates the same skill detects which services actually changed and rebuilds
            only those. Liquidsoap and the Controller <em>COPY</em> their source at build
            time, so a plain <code className="bs-code-inline">docker compose restart</code>{' '}
            silently runs stale code; the skill won't make that mistake.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ONCE IT'S ON THE AIR</p>
        <h2>Run the station from the CLI.</h2>
        <p>
          The setup wizard is one screen of the operator console. Run{' '}
          <code className="bs-code-inline">npm start</code> from the repo any time to open it:
          a menu to check the stack, run a diagnostic sweep, tail logs, restart a service,
          or open the web player and admin.
        </p>
        <CodeBlock>{`npm start`}</CodeBlock>
      </section>
    </SetupPage>
  );
}
