'use client';

import { Card, Pill } from '../ui';
import CodeBlock from '../../CodeBlock';
import type { Catalog } from './types';

interface Props {
  catalog: Catalog;
}

export default function McpTab({ catalog }: Props) {
  // The built-in HTTP endpoint — the recommended path. `${apiBase}${mcpHttpPath}`
  // is the real, reachable URL for this station.
  const mcpUrl = `${catalog.apiBase}${catalog.mcpHttpPath}`;

  const httpCmd = [
    'claude mcp add --transport http subwave \\',
    `  ${mcpUrl} \\`,
    '  --header "Authorization: Basic $(printf \'%s\' "$ADMIN_USER:$ADMIN_PASS" | base64)"',
  ].join('\n');

  const httpJson = JSON.stringify(
    {
      mcpServers: {
        subwave: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: 'Basic <base64 of user:pass>' },
        },
      },
    },
    null,
    2,
  );

  // Local-only alternative: the standalone stdio server, run from a clone.
  const stdioCmd = [
    'claude mcp add subwave \\',
    '  --env SUBWAVE_API_URL=http://localhost:7701 \\',
    '  --env SUBWAVE_ADMIN_USER=$ADMIN_USER \\',
    '  --env SUBWAVE_ADMIN_PASS=$ADMIN_PASS \\',
    '  -- npx tsx /absolute/path/to/subwave/mcp-subwave/src/index.ts',
  ].join('\n');

  return (
    <div className="grid gap-4">
      <Card
        title="Model Context Protocol"
        sub="Let an AI agent (Claude Code, Claude Desktop, any MCP client) drive the station with typed tools instead of raw HTTP."
      >
        <div className="text-[12px] leading-[1.6] text-muted">
          The station serves MCP over HTTP at <code>{mcpUrl}</code> — no clone, no local process. The endpoint
          mirrors the REST API: read tools work for anyone, DJ-control tools need this station&rsquo;s admin
          credentials passed as an <code>Authorization</code> header. Prefer the HTTP setup below; the stdio
          server is only for local-only use.
        </div>
      </Card>

      <Card title="Claude Code (HTTP)" sub="Recommended — connect with a URL">
        <CodeBlock lang="sh">{httpCmd}</CodeBlock>
      </Card>

      <Card title="Claude Desktop (HTTP)" sub="Add to claude_desktop_config.json">
        <CodeBlock lang="json">{httpJson}</CodeBlock>
      </Card>

      <Card title="Local stdio server" sub="Alternative — runs from a repo clone, no HTTP port exposed">
        <div className="mb-2 text-[11px] leading-[1.6] text-muted">
          Runs the standalone server via <code>tsx</code> straight from the clone (no build step).
        </div>
        <CodeBlock lang="sh">{stdioCmd}</CodeBlock>
      </Card>

      <Card title={`Tools (${catalog.mcpTools.length})`}>
        <div className="grid gap-1.5">
          {catalog.mcpTools.map(t => (
            <div key={t.name} className="border border-separator-strong bg-bg px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-[12px] font-semibold">{t.name}</code>
                {t.auth === 'admin'
                  ? <Pill tone="accent">admin</Pill>
                  : <Pill>public</Pill>}
                {t.mutatesAir && <Pill className="border-vermilion text-vermilion">on-air</Pill>}
                <code className="ml-auto text-[11px] text-muted">{t.endpoint}</code>
              </div>
              <div className="mt-1 text-[11px] leading-[1.5] text-muted">{t.description}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
