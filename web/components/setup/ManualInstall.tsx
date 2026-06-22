import Link from 'next/link';
import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

const ROOT_ENV_TEMPLATE = `# .env (repo root) — three keys, that's the whole boot config.

# Admin gate for /admin + the first-run wizard. REQUIRED in prod.
ADMIN_USER=admin
ADMIN_PASS=replace-me-with-a-strong-string   # openssl rand -hex 16

# Public origin — used for OG tags, sitemap, share cards.
SITE_URL=https://radio.example.com`;

export default function ManualInstall() {
  return (
    <SetupPage
      eyebrow="SETUP · 03"
      title="Run the commands yourself."
      intro="The no-CLI route: same result, no `subwave` binary on your host. Reach for it if you'd rather not run an installer, you're scripting the deploy, or you just like typing the commands yourself. Four steps get you a public single-host deploy: Caddy on the edge, Cloudflare in front, and Icecast, Controller, and Web kept internal."
      current="/setup/manual"
    >
      <section className="bs-section">
        <div className="bs-callout">
          <div className="bs-eyebrow">PREFER THE CLI?</div>
          <p>
            If a single binary on your host doesn&apos;t bother you, the standalone
            CLI folds these four steps into{' '}
            <code className="bs-code-inline">curl … | sh</code> (which chains{' '}
            <code className="bs-code-inline">init</code> and{' '}
            <code className="bs-code-inline">start</code> behind two Enter
            prompts) followed by{' '}
            <code className="bs-code-inline">subwave setup</code>. See{' '}
            <Link href="/setup/quick-start">Quick Start</Link>. It pulls the
            same compose images and writes to the same{' '}
            <code className="bs-code-inline">state/</code> layout, so you can switch
            between the two whenever you like.
          </p>
        </div>
        <div className="bs-step">
          <div className="bs-step-num">01</div>
          <div className="bs-step-body">
            <h3>Grab the two files</h3>
            <p>
              No clone needed. SUB/WAVE installs from a single{' '}
              <code className="bs-code-inline">docker-compose.yml</code> + a 3-var{' '}
              <code className="bs-code-inline">.env</code>:
            </p>
            <CodeBlock>{`mkdir subwave && cd subwave
curl -O https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/perminder-klair/subwave/main/.env.example
mv .env.example .env
$EDITOR .env`}</CodeBlock>
            <p>
              Three keys boot the stack. The first-run wizard at{' '}
              <code className="bs-code-inline">/onboarding</code> collects the rest once
              the containers come up.
            </p>
            <CodeBlock lang="env">{ROOT_ENV_TEMPLATE}</CodeBlock>
            <div className="bs-callout">
              <div className="bs-eyebrow">PREFER A CLONE?</div>
              <p>
                Clone the repo and run{' '}
                <code className="bs-code-inline">./scripts/setup.sh</code>. It scaffolds
                the same <code className="bs-code-inline">.env</code> and sets the
                state-dir permissions. Or run{' '}
                <code className="bs-code-inline">npm run setup</code> for a terminal
                wizard that does the same thing the browser flow does, no browser needed.
              </p>
            </div>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">02</div>
          <div className="bs-step-body">
            <h3>Boot the stack</h3>
            <CodeBlock>{`docker compose up -d`}</CodeBlock>
            <p>What just started:</p>
            <ul className="bs-list">
              <li>
                <strong>broadcast</strong> — icecast2 and liquidsoap together in one
                container. On first boot it generates three random Icecast passwords and
                saves them to{' '}
                <code className="bs-code-inline">state/icecast-secrets.env</code>{' '}
                (no <code className="bs-code-inline">scripts/setup.sh</code> step
                needed). The entrypoint sources them before it execs liquidsoap.
                Internal-only.
              </li>
              <li><strong>controller</strong> — the DJ brain. This is the one that talks to
              Navidrome and your LLM.</li>
              <li><strong>web</strong> — Next.js UI, internal-only</li>
              <li>
                <strong>caddy</strong> — the only thing bound to a host port (
                <code className="bs-code-inline">:7700</code>)
              </li>
            </ul>
            <div className="bs-callout">
              <div className="bs-eyebrow">PIN A VERSION</div>
              <p>
                By default,{' '}
                <code className="bs-code-inline">docker-compose.yml</code> pulls{' '}
                <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-*:latest</code>.
                To pin a release, set{' '}
                <code className="bs-code-inline">SUBWAVE_VERSION=v1.2.3</code> in your
                root <code className="bs-code-inline">.env</code>. To build from a local
                clone instead, add{' '}
                <code className="bs-code-inline">--build</code> to the up command.
              </p>
            </div>
            <div className="bs-callout">
              <div className="bs-eyebrow">ALREADY RUNNING TRAEFIK OR NGINX?</div>
              <p>
                Swap the compose file for{' '}
                <code className="bs-code-inline">docker-compose.byo.yml</code>:
                same stack minus the bundled Caddy, with web / controller / broadcast bound to{' '}
                <code className="bs-code-inline">:7700</code> /{' '}
                <code className="bs-code-inline">:7701</code> /{' '}
                <code className="bs-code-inline">:7702</code>.
              </p>
              <p>
                <strong>You have to front this with a reverse proxy.</strong> The web
                UI calls <code className="bs-code-inline">/api/*</code>,{' '}
                <code className="bs-code-inline">/stream.mp3</code>, and{' '}
                <code className="bs-code-inline">/stream.opus</code> same-origin,
                and those paths are baked into the image at build time. Without a
                proxy routing them to the controller and Icecast, the page loads
                but the player is dead: no metadata, no audio. Here&apos;s the route table
                to replicate (it mirrors{' '}
                <code className="bs-code-inline">docker/Caddyfile</code>):
              </p>
              <CodeBlock>{`/stream.mp3   →  host:7702           # disable proxy buffering for live audio
/stream.opus  →  host:7702           # ditto — Ogg-Opus mount served from same Icecast
/api/*        →  host:7701/*         # strip the /api prefix
/*            →  host:7700           # everything else → web`}</CodeBlock>
              <p>
                If you need separate hostnames per surface, rebuild the web image
                with <code className="bs-code-inline">NEXT_PUBLIC_API_URL</code> and{' '}
                <code className="bs-code-inline">NEXT_PUBLIC_STREAM_URL</code> set;
                those are baked at build time, not runtime.
              </p>
            </div>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">03</div>
          <div className="bs-step-body">
            <h3>Finish setup in the browser</h3>
            <CodeBlock>{`open http://localhost:7700/onboarding`}</CodeBlock>
            <p className="text-muted">
              Or <code className="bs-code-inline">https://your-host/onboarding</code>{' '}
              if you&apos;re not on localhost.
            </p>
            <p>
              Sign in with the{' '}
              <code className="bs-code-inline">ADMIN_USER</code> /{' '}
              <code className="bs-code-inline">ADMIN_PASS</code> you set in{' '}
              <code className="bs-code-inline">.env</code>. The wizard collects each of
              these, tests them against the live service, and saves them:
            </p>
            <ul className="bs-list">
              <li><strong>Navidrome</strong> — URL + user + pass. Saved to{' '}
              <code className="bs-code-inline">state/setup-config.json</code>.</li>
              <li><strong>LLM provider + model</strong> — Ollama (homelab default,
              no key), Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Vercel AI Gateway,
              or any self-hosted OpenAI-compatible server. Cloud API keys go to{' '}
              <code className="bs-code-inline">state/secrets.env</code> (mode 0600,
              sourced into <code className="bs-code-inline">process.env</code> on boot).</li>
              <li><strong>TTS engine</strong> — Piper (default) and Kokoro both run inside
              the controller image. Cloud (OpenAI / ElevenLabs) just needs an API key.
              Chatterbox (voice cloning) and PocketTTS (multilingual) live in the optional{' '}
              <code className="bs-code-inline">tts-heavy</code> sidecar: tick the
              &ldquo;Enable Chatterbox + PocketTTS&rdquo; box in the wizard, then start it
              with <code className="bs-code-inline">docker compose --profile tts-heavy up -d</code>{' '}
              (or set <code className="bs-code-inline">COMPOSE_PROFILES=tts-heavy</code> in{' '}
              <code className="bs-code-inline">.env</code> so future{' '}
              <code className="bs-code-inline">up -d</code> calls bring it up automatically).</li>
              <li><strong>DJ persona</strong> — station name, location for weather,
              optional system-prompt override.</li>
              <li><strong>Jingles</strong> — one-click button to render 5 default
              station idents via your chosen TTS engine.</li>
            </ul>
            <div className="bs-callout">
              <div className="bs-eyebrow">PREFER THE TERMINAL?</div>
              <p>
                <code className="bs-code-inline">npm run setup</code> walks the same flow
                in the terminal. Same checks, same saved config, same end state. That path
                needs a <code className="bs-code-inline"> git clone</code> and Node 20+.
              </p>
            </div>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">04</div>
          <div className="bs-step-body">
            <h3>Verify the broadcast</h3>
            <p>
              The repo ships a health probe. It checks the containers, hits{' '}
              <code className="bs-code-inline">/api/health</code> and{' '}
              <code className="bs-code-inline">/api/now-playing</code>, and scans recent logs
              for errors. Run it after any deploy:
            </p>
            <CodeBlock>{`./scripts/health-check.sh`}</CodeBlock>
            <p className="text-muted">
              Auto-detects which compose file is live and which host port Caddy is mapped to.
              Exits 0 if healthy. Safe to wire into cron or a status page.
            </p>
            <div className="bs-callout">
              <div className="bs-eyebrow">DAY-TO-DAY OPERATOR CONSOLE</div>
              <p>
                <code className="bs-code-inline">npm start</code> opens the operator console:
                a menu for stack status, a diagnostic sweep, logs, restart, and the terminal
                player. It&apos;s how you&apos;ll run the station day to day once it&apos;s installed.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHAT'S NEXT</p>
        <h2>Keep it running.</h2>
        <p>
          The stack is on the air. When a new version lands, head to{' '}
          <Link href="/setup/updates" className="bs-link">Updates &amp; Help</Link> for the
          rebuild-only-what-changed workflow and a troubleshooting checklist.
        </p>
      </section>
    </SetupPage>
  );
}
