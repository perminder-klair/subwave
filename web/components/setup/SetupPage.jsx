'use client';

import Link from 'next/link';
import Masthead from '../landing/Masthead';
import StationFooter from '../landing/StationFooter';
import CodeBlock from './CodeBlock';

const ENV_TEMPLATE = `# controller/.env — point SUB/WAVE at your services

# Navidrome (or any Subsonic-API server)
NAVIDROME_URL=http://navidrome.local:4533
NAVIDROME_USER=your-username
NAVIDROME_PASS=your-password

# (Optional) If the controller can read your music files directly from
# disk, set this to the mount path — skips streaming over HTTP.
# MUSIC_LIBRARY_PATH=/music

# Ollama — wherever you run it
OLLAMA_URL=http://ollama.local:11434
OLLAMA_MODEL=qwen2.5:7b

# Icecast source password (any string; just match the docker-compose env)
ICECAST_SOURCE_PASSWORD=replace-me-with-a-strong-string

# (Optional) Admin auth — Settings, Debug, Jingles are open without these.
# ADMIN_USER=admin
# ADMIN_PASS=replace-me`;

const ICECAST_ENV = `# docker/.env
ICECAST_SOURCE_PASSWORD=replace-me-with-a-strong-string
ICECAST_ADMIN_PASSWORD=another-strong-string
ICECAST_RELAY_PASSWORD=another-strong-string
STATE_DIR=/var/lib/subwave
SUBWAVE_HOMEPAGE=landing`;

export default function SetupPage() {
  return (
    <div style={{ background: 'var(--bg)', color: 'var(--ink)', minHeight: '100vh' }}>
      <Masthead />

      <main className="bs-paper">
        <section className="bs-setup-hero">
          <p className="bs-eyebrow">SELF-HOSTED · OPEN SOURCE</p>
          <h1>Run your own SUB/WAVE.</h1>
          <p>
            SUB/WAVE points at <strong style={{ color: 'var(--ink)' }}>your</strong> Navidrome
            library and <strong style={{ color: 'var(--ink)' }}>your</strong> Ollama instance.
            Once it's running, the LLM-driven DJ broadcasts from your homelab, plays from
            your music collection, and answers requests from anyone with the URL.
            About ten minutes to set up if you already have Navidrome and Ollama running.
          </p>
        </section>

        {/* ── Step 1 ── prerequisites ─────────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">01</div>
          <div className="bs-step-body">
            <h3>Have these ready</h3>
            <p>
              SUB/WAVE doesn't ship Navidrome or Ollama — it talks to yours. Get them
              running first if they aren't already.
            </p>
            <ul className="bs-list">
              <li><strong>Docker + Docker Compose</strong> — the stack ships as four containers.</li>
              <li>
                <strong>Navidrome</strong> (or any Subsonic-API server) reachable from where the
                stack runs. Note the URL, username, password.
                <a href="https://www.navidrome.org/" target="_blank" rel="noreferrer" className="bs-link" style={{ marginLeft: 6, fontSize: 12 }}>navidrome.org ↗</a>
              </li>
              <li>
                <strong>Ollama</strong> with a model that supports{' '}
                <code className="bs-code-inline">format: json</code> (qwen2.5:7b, llama3.1:8b,
                nemotron). Note the URL and model name.
                <a href="https://ollama.com/" target="_blank" rel="noreferrer" className="bs-link" style={{ marginLeft: 6, fontSize: 12 }}>ollama.com ↗</a>
              </li>
              <li><strong>A box to run on</strong> — a homelab Linux box, a VPS, a Mac. Tailscale or Cloudflare in front for sharing.</li>
            </ul>
          </div>
        </div>

        {/* ── Step 2 ── clone ─────────────────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">02</div>
          <div className="bs-step-body">
            <h3>Clone the repo</h3>
            <CodeBlock>{`git clone https://github.com/pklair/subwave.git
cd subwave`}</CodeBlock>
          </div>
        </div>

        {/* ── Step 3 ── controller .env ───────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">03</div>
          <div className="bs-step-body">
            <h3>Tell the controller where your Navidrome and Ollama live</h3>
            <p>Copy the template and fill in your values:</p>
            <CodeBlock>{`cp controller/.env.example controller/.env
$EDITOR controller/.env`}</CodeBlock>
            <p>The four values that actually matter (the rest of the template has good defaults):</p>
            <CodeBlock lang="env">{ENV_TEMPLATE}</CodeBlock>
            <div className="bs-callout">
              <div className="bs-eyebrow">CONNECTION TEST</div>
              <p>
                Before booting the stack, you can sanity-check Navidrome from your terminal:
              </p>
              <CodeBlock>{`curl "$NAVIDROME_URL/rest/ping.view?u=$NAVIDROME_USER&p=$NAVIDROME_PASS&v=1.16.1&c=sub-wave&f=json"`}</CodeBlock>
              <p>You should get back <code className="bs-code-inline">{'{ "subsonic-response": { "status": "ok" ... } }'}</code>.</p>
            </div>
          </div>
        </div>

        {/* ── Step 4 ── icecast/state ─────────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">04</div>
          <div className="bs-step-body">
            <h3>Configure the broadcast layer</h3>
            <p>
              Icecast needs three passwords and a state directory the containers
              can share. <code className="bs-code-inline">scripts/setup.sh</code> renders
              the Icecast config from a template; running it once is enough.
            </p>
            <CodeBlock lang="env">{ICECAST_ENV}</CodeBlock>
            <CodeBlock>{`sudo STATE_DIR=/var/lib/subwave ./scripts/setup.sh`}</CodeBlock>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>
              The <code className="bs-code-inline">STATE_DIR</code> is where Liquidsoap, the
              controller, and the web container exchange files (next track, voice WAVs,
              now-playing). Anything that survives <code className="bs-code-inline">docker compose down</code>
              {' '}lives there.
            </p>
          </div>
        </div>

        {/* ── Step 5 ── boot ──────────────────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">05</div>
          <div className="bs-step-body">
            <h3>Boot the stack</h3>
            <CodeBlock>{`docker compose -f docker/docker-compose.prod.yml up -d --build`}</CodeBlock>
            <p>What just started:</p>
            <ul className="bs-list">
              <li><strong>icecast</strong> — broadcast endpoint, internal-only</li>
              <li><strong>liquidsoap</strong> — mixer feeding Icecast</li>
              <li><strong>controller</strong> — the DJ brain (this is the one talking to Navidrome + Ollama)</li>
              <li><strong>web</strong> — Next.js UI, internal-only</li>
              <li><strong>caddy</strong> — the only thing bound to a host port (<code className="bs-code-inline">:4800</code>)</li>
            </ul>
            <p>
              Generate the Piper station idents the first time:
            </p>
            <CodeBlock>{`./scripts/generate-jingles.sh`}</CodeBlock>
          </div>
        </div>

        {/* ── Step 6 ── open ──────────────────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">06</div>
          <div className="bs-step-body">
            <h3>Tune in</h3>
            <CodeBlock>{`open http://localhost:4800`}</CodeBlock>
            <p>
              Behind a domain? Put it behind Cloudflare or Tailscale; Caddy
              has <code className="bs-code-inline">auto_https off</code>, so terminate TLS upstream.
            </p>
            <div className="bs-callout">
              <div className="bs-eyebrow">EDIT THE DJ</div>
              <p>
                Open the player at <code className="bs-code-inline">/listen</code>, click
                the settings icon in the top bar, and edit the DJ's name, soul, and system
                prompt. Persona changes apply on the next intro — no restart needed.
              </p>
            </div>
          </div>
        </div>

        {/* ── Step 7 ── verify ───────────────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">07</div>
          <div className="bs-step-body">
            <h3>Verify the broadcast</h3>
            <p>
              The repo ships a health-probe that checks the containers,
              hits <code className="bs-code-inline">/api/health</code> and
              {' '}<code className="bs-code-inline">/api/now-playing</code>, and
              scans recent logs for errors. Run it after any deploy:
            </p>
            <CodeBlock>{`./.claude/skills/subwave-deploy/scripts/health-check.sh`}</CodeBlock>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>
              Auto-detects which compose file is live and which host port Caddy
              is mapped to. Exits 0 if healthy. Safe to wire into cron or a
              status page.
            </p>
          </div>
        </div>

        {/* ── Step 8 ── keep up to date ──────────────────────────────────── */}
        <div className="bs-step">
          <div className="bs-step-num">08</div>
          <div className="bs-step-body">
            <h3>Keep it up to date</h3>
            <p>
              Updates are <strong style={{ color: 'var(--ink)' }}>pull → rebuild only
              what changed → recreate</strong>. Liquidsoap and the Controller{' '}
              <em>COPY</em> source at build time, so{' '}
              <code className="bs-code-inline">docker compose restart</code> does
              {' '}<strong>not</strong> pick up code changes — you need{' '}
              <code className="bs-code-inline">up -d --build &lt;service&gt;</code>.
            </p>

            <table className="bs-rebuild-table">
              <thead>
                <tr>
                  <th>If this changed</th>
                  <th>Rebuild</th>
                </tr>
              </thead>
              <tbody>
                <tr><td><code className="bs-code-inline">controller/src/**</code></td>          <td>controller</td></tr>
                <tr><td><code className="bs-code-inline">liquidsoap/radio.liq</code></td>       <td>liquidsoap</td></tr>
                <tr><td><code className="bs-code-inline">web/**</code></td>                     <td>web</td></tr>
                <tr><td><code className="bs-code-inline">docker/Caddyfile</code></td>           <td>just <code className="bs-code-inline">restart caddy</code> (mounted)</td></tr>
                <tr><td><code className="bs-code-inline">docker/docker-compose*.yml</code></td> <td><code className="bs-code-inline">up -d</code> (compose decides)</td></tr>
                <tr><td>README / TODO / docs</td>                                               <td>nothing</td></tr>
              </tbody>
            </table>

            <p>Typical manual deploy:</p>
            <CodeBlock>{`git pull --ff-only
# rebuild only what changed (example: controller + web)
docker compose -f docker/docker-compose.prod.yml up -d --build controller web
# then verify
./.claude/skills/subwave-deploy/scripts/health-check.sh`}</CodeBlock>

            <div className="bs-callout">
              <div className="bs-eyebrow">CLAUDE CODE USERS</div>
              <p>
                The repo ships a <code className="bs-code-inline">subwave-deploy</code> agent skill at{' '}
                <code className="bs-code-inline">.claude/skills/subwave-deploy/</code>{' '}
                that automates the whole "pull, detect changes, rebuild only
                the affected services, verify health" loop. Just say{' '}
                <em>"deploy subwave"</em> or <em>"pull and restart"</em> in a
                Claude Code session running in the repo and it'll do the right
                thing — including the bits that aren't obvious, like not using{' '}
                <code className="bs-code-inline">restart</code> for source changes.
              </p>
            </div>
          </div>
        </div>

        {/* ── Footer note ─────────────────────────────────────────────────── */}
        <section className="bs-section">
          <p className="bs-eyebrow">WHEN THINGS GO WRONG</p>
          <h2>Logs are the source of truth.</h2>
          <ul className="bs-list">
            <li>
              <strong>Controller logs</strong> —
              <code className="bs-code-inline">docker compose -f docker/docker-compose.prod.yml logs -f controller</code>
            </li>
            <li>
              <strong>Liquidsoap logs</strong> —
              <code className="bs-code-inline">docker compose -f docker/docker-compose.prod.yml logs -f liquidsoap</code>
            </li>
            <li>
              <strong>Built-in diagnostics</strong> —
              open <Link href="/debug" className="bs-link">/debug</Link> for a live snapshot
              of every state file, recent Ollama calls, Icecast status, and the most recent
              100 lines of Liquidsoap.
            </li>
            <li>
              <strong>Source code</strong> —{' '}
              <a href="https://github.com/pklair/subwave" target="_blank" rel="noreferrer" className="bs-link">
                github.com/pklair/subwave ↗
              </a>{' '}
              — file an issue or read the CLAUDE.md for architecture notes.
            </li>
          </ul>
        </section>

        <StationFooter />
      </main>
    </div>
  );
}
