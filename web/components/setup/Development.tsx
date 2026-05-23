import SetupPage from './SetupPage';
import CodeBlock from './CodeBlock';

export default function Development() {
  return (
    <SetupPage
      eyebrow="SETUP · 04"
      title="Hacking on SUB/WAVE."
      intro="Three compose files, three deployment shapes. Dev mode runs the radio backend in Docker and the Next.js UI on the host with hot reload, so you can iterate on the web without a rebuild. The two prod variants differ only at the edge — one bundles Caddy, the other binds host ports for your own reverse proxy."
      current="/setup/development"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE THREE STACKS</p>
        <h2>Compose files.</h2>
        <table className="bs-rebuild-table mt-3">
          <thead>
            <tr>
              <th>Compose file</th>
              <th>What runs</th>
              <th>State dir</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code className="bs-code-inline">docker/docker-compose.yml</code></td>
              <td>icecast · liquidsoap · controller (web runs separately on host)</td>
              <td><code className="bs-code-inline">./state</code></td>
            </tr>
            <tr>
              <td><code className="bs-code-inline">docker/docker-compose.prod.yml</code></td>
              <td>+ web (built image) + caddy edge on <code className="bs-code-inline">:7700</code></td>
              <td><code className="bs-code-inline">${'{STATE_DIR:-<repo>/state}'}</code></td>
            </tr>
            <tr>
              <td><code className="bs-code-inline">docker/docker-compose.byo-proxy.yml</code></td>
              <td>same as prod minus caddy — web, controller, icecast on host ports{' '}
                <code className="bs-code-inline">:7700</code> /{' '}
                <code className="bs-code-inline">:7701</code> /{' '}
                <code className="bs-code-inline">:7702</code> for your own reverse proxy
              </td>
              <td><code className="bs-code-inline">${'{STATE_DIR:-<repo>/state}'}</code></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">DAY-TO-DAY COMMANDS</p>
        <h2>Everything's an npm script.</h2>
        <p>
          The compose flags are all wired into{' '}
          <code className="bs-code-inline">package.json</code> so you don't have to remember
          them:
        </p>
        <CodeBlock>{`npm run setup        # interactive wizard (writes envs, brings the stack up)
npm run dev          # alias for setup — same wizard
npm run dev:docker   # docker compose up -d        (radio backend only)
npm run dev:web      # next dev on :7700           (hot-reloaded UI)
npm run rebuild      # docker compose up -d --build  (after controller/liquidsoap src changes)
npm run logs         # tail docker logs
npm run jingles      # render station idents via Piper
npm run down         # stop the stack`}</CodeBlock>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">A TYPICAL SESSION</p>
        <h2>Backend in Docker, UI on the host.</h2>
        <CodeBlock>{`# one-time, in two terminals:
npm run dev:docker   # terminal 1: backend (Icecast, Liquidsoap, Controller)
npm run dev:web      # terminal 2: Next.js on http://localhost:7700

# editing web/** — saves are hot-reloaded, no docker action needed.
# editing controller/src/** or liquidsoap/radio.liq:
npm run rebuild      # rebuilds + recreates the affected containers`}</CodeBlock>

        <div className="bs-callout">
          <div className="bs-eyebrow">THE ONE GOTCHA</div>
          <p>
            <strong>Code changes need a rebuild, not a restart.</strong> Both the controller
            and Liquidsoap Dockerfiles <code className="bs-code-inline">COPY</code> their
            source at build time — they don't bind-mount it. So{' '}
            <code className="bs-code-inline">docker compose restart controller</code> will
            cheerfully rerun the same baked-in code as before.{' '}
            <code className="bs-code-inline">npm run rebuild</code> (or{' '}
            <code className="bs-code-inline">docker compose up -d --build &lt;service&gt;</code>)
            is what you want.
          </p>
          <p className="mt-2 text-muted">
            The web dev server (<code className="bs-code-inline">npm run dev:web</code>) is
            exempt — Next.js hot-reloads, so edits to{' '}
            <code className="bs-code-inline">web/**</code> show up instantly without touching
            Docker.
          </p>
        </div>
      </section>
    </SetupPage>
  );
}
