import Link from 'next/link';
import ManualPage from './ManualPage';

// The five MCP tools — see docs/mcp-server.md for the full contract.
const TOOLS = [
  { name: 'subwave_now_playing', summary: 'The current track, station context, and live listener count.', auth: '—' },
  { name: 'subwave_station_state', summary: 'The upcoming queue, recent history, and the DJ booth log.', auth: '—' },
  { name: 'subwave_request_song', summary: 'Queues a track from a natural-language request: a song, an artist, or a vibe.', auth: '—' },
  { name: 'subwave_dj_announce', summary: 'Puts a spoken update on air, rewritten in persona or read verbatim.', auth: 'Admin' },
  { name: 'subwave_dj_segment', summary: 'Fires a scripted segment on demand: station ID, the hour, or a link.', auth: 'Admin' },
];

export default function AgentAccess() {
  return (
    <ManualPage
      eyebrow="MANUAL · 15"
      title="Agent access."
      intro="SUB/WAVE isn't only for human listeners. An AI agent can read what's on air and put songs and DJ segments onto the broadcast through the station's MCP server."
      current="/manual/mcp"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">WHAT IT IS</p>
        <h2>An MCP server for the station.</h2>
        <p>
          <code className="bs-code-inline">subwave-mcp</code> is a small server that
          speaks the{' '}
          <a
            href="https://modelcontextprotocol.io"
            className="bs-link"
            target="_blank"
            rel="noreferrer"
          >
            Model Context Protocol
          </a>,{' '}
          the standard way an AI agent like Claude reaches an external tool. It is the
          agent-facing twin of the listener request panel: where a human types into the
          browser, an agent calls a tool, and the same controller does the work.
        </p>
        <p className="text-muted">
          The server holds no logic of its own; each tool is a typed wrapper over one
          controller endpoint. The agent never sees a URL or an auth header, only the
          five intent-shaped tools below.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE TOOLS</p>
        <h2>Five things an agent can do.</h2>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>What it does</th>
              <th>Auth</th>
            </tr>
          </thead>
          <tbody>
            {TOOLS.map((t) => (
              <tr key={t.name}>
                <td><code>{t.name}</code></td>
                <td>{t.summary}</td>
                <td>{t.auth}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted">
          Like the human request path, <code className="bs-code-inline">subwave_request_song</code>{' '}
          queues a track (it never interrupts the song that's playing) and it's
          rate-limited. The two DJ-control tools speak immediately.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PUBLIC vs ADMIN</p>
        <h2>Reading and requesting are open.</h2>
        <p>
          The three read-and-request tools need no credentials: they map to the same
          public, rate-limited endpoints a browser uses. The two DJ-control tools, which
          put a voice on air, are gated: the server sends the station's{' '}
          <code className="bs-code-inline">ADMIN_USER</code> /{' '}
          <code className="bs-code-inline">ADMIN_PASS</code> as a Basic auth header, read
          from its own environment. Without them, an agent can still see what's on air
          and request songs; it just can't drive the DJ.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WIRING IT UP</p>
        <h2>Point an MCP client at it.</h2>
        <p>
          The server lives in the repo at <code className="bs-code-inline">mcp-subwave/</code>.
          Build it once with <code className="bs-code-inline">npm install &amp;&amp; npm run build</code>,
          then point any MCP client (Claude Code, Claude Desktop, or another) at the
          built <code className="bs-code-inline">dist/index.js</code>, passing the
          controller URL and, optionally, the admin credentials as environment variables.
          The station must be running first.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">FULL REFERENCE</div>
          <p>
            <code className="bs-code-inline">docs/mcp-server.md</code> in the repo covers
            every tool's options, the configuration variables, the error messages, and
            ready-to-paste client snippets. To run the station itself, see{' '}
            <Link href="/manual/admin" className="bs-link">Admin &amp; Settings</Link>.
          </p>
        </div>
      </section>
    </ManualPage>
  );
}
