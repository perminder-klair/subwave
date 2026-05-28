import Link from 'next/link';
import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

export default function Updates() {
  return (
    <SetupPage
      eyebrow="SETUP · 05"
      title="Updates & help."
      intro="Pulling a new version, rebuilding only what changed, and what to check when the stream goes quiet. Liquidsoap and the Controller COPY source at build time, so docker compose restart does not pick up code changes. You need up -d --build."
      current="/setup/updates"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">KEEPING IT UP TO DATE</p>
        <h2>Rebuild only what changed.</h2>
        <table className="bs-rebuild-table">
          <thead>
            <tr>
              <th>If this changed</th>
              <th>Rebuild</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code className="bs-code-inline">controller/src/**</code></td><td>controller</td></tr>
            <tr><td><code className="bs-code-inline">liquidsoap/radio.liq</code></td><td>broadcast</td></tr>
            <tr><td><code className="bs-code-inline">web/**</code></td><td>web (prod) · hot-reload (dev)</td></tr>
            <tr><td><code className="bs-code-inline">docker/Caddyfile</code></td><td>just <code className="bs-code-inline">restart caddy</code> (mounted)</td></tr>
            <tr><td><code className="bs-code-inline">docker-compose*.yml</code></td><td><code className="bs-code-inline">up -d</code> (compose decides)</td></tr>
            <tr><td>README / TODO / docs</td><td>nothing</td></tr>
          </tbody>
        </table>

        <p className="mt-4">Typical manual deploy:</p>
        <CodeBlock>{`git pull --ff-only
# rebuild only what changed (example: controller + web)
docker compose up -d --build controller web
# then verify
./scripts/health-check.sh`}</CodeBlock>

        <div className="bs-callout">
          <div className="bs-eyebrow">USING THE STANDALONE CLI?</div>
          <p>
            If you installed via{' '}
            <code className="bs-code-inline">curl cli.getsubwave.com | sh</code>, two
            commands cover both update axes:
          </p>
          <CodeBlock>{`subwave update         # pull new images, recreate changed services
subwave self-update    # replace the CLI binary itself with the latest release`}</CodeBlock>
          <p className="text-muted">
            <code className="bs-code-inline">subwave update</code> is a docker
            pull + up -d wrapper that knows which compose file is live;{' '}
            <code className="bs-code-inline">self-update</code> re-runs the
            installer in place.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">RUNNING FROM GHCR IMAGES (NO CLI)?</div>
          <p>
            If you&apos;re pulling prebuilt images from{' '}
            <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-*</code>{' '}
            without the CLI, the rebuild step becomes a pull:
          </p>
          <CodeBlock>{`# pin SUBWAVE_VERSION in .env, then:
docker compose pull
docker compose up -d`}</CodeBlock>
          <p className="text-muted">
            Same flow if you&apos;re on{' '}
            <code className="bs-code-inline">docker-compose.byo.yml</code> — just
            swap the file flag.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">OR LET CLAUDE CODE DO IT</div>
          <p>
            The <code className="bs-code-inline">subwave-deploy</code> skill at{' '}
            <code className="bs-code-inline">.claude/skills/subwave-deploy/</code> automates
            the whole "pull, detect what changed, rebuild only the affected services, verify
            health" loop. Open a Claude Code session in the repo and say{' '}
            <em>"deploy subwave"</em> or <em>"pull and restart"</em>.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHEN THINGS GO WRONG</p>
        <h2>Logs are the source of truth.</h2>
        <ul className="bs-list">
          <li>
            <strong>Controller logs</strong> —{' '}
            <code className="bs-code-inline">docker compose logs -f controller</code>
          </li>
          <li>
            <strong>Broadcast logs</strong> (icecast + liquidsoap) —{' '}
            <code className="bs-code-inline">docker compose logs -f broadcast</code>
          </li>
          <li>
            <strong>Operator console</strong> —{' '}
            <code className="bs-code-inline">npm start</code> opens a menu whose{' '}
            <strong>doctor</strong> option runs a full diagnostic sweep and{' '}
            <strong>logs</strong> tails any service without the long compose flags.
          </li>
          <li>
            <strong>Built-in diagnostics</strong> — open{' '}
            <Link href="/admin/debug" className="bs-link">/admin/debug</Link> for a live
            snapshot of every state file, recent LLM calls, Icecast status, and the most
            recent 100 lines of Liquidsoap.
          </li>
          <li>
            <strong>Source code</strong> —{' '}
            <a href="https://github.com/perminder-klair/subwave" target="_blank" rel="noreferrer" className="bs-link">
              github.com/perminder-klair/subwave ↗
            </a>{' '}
            — file an issue, or read the CLAUDE.md for architecture notes.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">RUNNING THE STATION</p>
        <h2>Now shape the DJ.</h2>
        <p>
          Installation is the start. Tuning the personas, scheduling shows, choosing the LLM
          provider, and managing jingles all happen in the admin console — that's covered in{' '}
          <Link href="/manual/admin" className="bs-link">the manual's Admin &amp; Settings
          page</Link>.
        </p>
      </section>
    </SetupPage>
  );
}
