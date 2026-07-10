import Link from 'next/link';
import ManualPage from './ManualPage';

// The MCP tool surface — see docs/mcp-server.md for the full contract.
const TOOLS = [
  { name: 'subwave_health', summary: 'Liveness: the controller is reachable and the stream reports on-air.', auth: '—' },
  { name: 'subwave_now_playing', summary: 'The current track, station context, and live listener count.', auth: '—' },
  { name: 'subwave_station_state', summary: 'The upcoming queue, recent history, and the DJ booth log.', auth: '—' },
  { name: 'subwave_schedule', summary: 'Personas, shows, and the weekly schedule grid, in station time.', auth: '—' },
  { name: 'subwave_session', summary: "The DJ's live session and its recent on-air transcript.", auth: '—' },
  { name: 'subwave_request_song', summary: 'Queues a track from a natural-language request — a song, an artist, or a vibe — and waits for the booth’s verdict.', auth: '—' },
  { name: 'subwave_request_status', summary: 'Checks on an earlier request by its receipt id.', auth: '—' },
  { name: 'subwave_search_library', summary: 'Searches the library by terms: exact results, no LLM, no rate limit.', auth: 'Admin' },
  { name: 'subwave_queue_track', summary: 'Queues an exact search result — an operator pick, no DJ intro.', auth: 'Admin' },
  { name: 'subwave_skip_track', summary: 'Force-ends the current track. An operator override; listeners have no skip.', auth: 'Admin' },
  { name: 'subwave_dj_announce', summary: 'Puts a spoken update on air, rewritten in persona or read verbatim — optionally over a sound-effect stinger.', auth: 'Admin' },
  { name: 'subwave_dj_segment', summary: 'Fires a scripted segment on demand: station ID, the hour, a link, guest banter, or a programme beat.', auth: 'Admin' },
  { name: 'subwave_list_skills', summary: 'The skill catalogue — weather, news, and any custom skills installed.', auth: 'Admin' },
  { name: 'subwave_run_skill', summary: 'Runs a named skill segment now, with real data behind it.', auth: 'Admin' },
  { name: 'subwave_list_sfx', summary: 'The sound-effects library: short stingers the station can play.', auth: 'Admin' },
  { name: 'subwave_play_sfx', summary: 'Fires a sound effect on air immediately, mixed over the programme.', auth: 'Admin' },
  { name: 'subwave_refresh_playlist', summary: 'Rebuilds the fallback auto-playlist for the current mood.', auth: 'Admin' },
];

export default function AgentAccess() {
  return (
    <ManualPage
      eyebrow="MANUAL · 14"
      title="Agent access."
      intro="SUB/WAVE isn't only for human listeners. An AI agent can read what's on air and put songs, DJ segments, and sound effects onto the broadcast through the station's MCP server."
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
          It holds almost no logic of its own; each tool is a typed wrapper over one
          controller endpoint. The agent never sees a URL or an auth header, only the
          intent-shaped tools below. The station serves these tools over HTTP directly,
          so a client connects with just a URL — no clone, no local process.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE TOOLS</p>
        <h2>Seventeen things an agent can do.</h2>
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
          rate-limited; the booth resolves the request in the background, so the tool
          waits for the outcome and reports the matched track and the DJ's ack. When an
          agent already knows the exact track, the search-and-queue pair does the same
          job with no LLM and no rate limit. The DJ-control tools speak immediately.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">AN ALERT, WITH AN AIRHORN</p>
        <h2>Attention first, then the message.</h2>
        <p>
          The announce tool takes an optional sound effect from the station's library,
          aired under its opening words. That turns an external watcher into a proper
          alert system: an agent monitoring weather warnings for your area can call{' '}
          <code className="bs-code-inline">subwave_dj_announce</code> with the warning
          text, <code className="bs-code-inline">mode: raw</code> so nothing gets
          paraphrased, and <code className="bs-code-inline">sfx: airhorn</code> to cut
          through the music before the words land. Effects can also fire on their own
          with <code className="bs-code-inline">subwave_play_sfx</code>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PUBLIC vs ADMIN</p>
        <h2>Reading and requesting are open.</h2>
        <p>
          The seven read-and-request tools need no credentials: they map to the same
          public endpoints a browser uses. Everything that drives the station — voice,
          segments, skills, effects, the queue, the skip — is gated by the station's
          admin credentials, passed as a Basic auth header (an{' '}
          <code className="bs-code-inline">Authorization</code> header on the HTTP
          endpoint, or <code className="bs-code-inline">ADMIN_USER</code> /{' '}
          <code className="bs-code-inline">ADMIN_PASS</code> for the local stdio server).
          Without them, an agent can still see what's on air and request songs; it just
          can't drive the DJ.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WIRING IT UP</p>
        <h2>Point an MCP client at it.</h2>
        <p>
          The quickest path is HTTP: point any MCP client (Claude Code, Claude Desktop,
          or another) at <code className="bs-code-inline">&lt;your-station&gt;/api/mcp</code>,
          passing the admin credentials as an{' '}
          <code className="bs-code-inline">Authorization</code> header. Nothing to
          install. The admin <strong>Connect → MCP</strong> screen gives you the exact
          command with your station's URL already filled in. A local stdio server (run
          from a clone) is available too when you'd rather not expose the endpoint. The
          station must be running first.
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
