'use client';

import { Card, Pill } from '../ui';
import { CodeBlock, CodeBlockCopyButton } from '../../ai-elements/code-block';
import { Snippet, SnippetAddon, SnippetCopyButton, SnippetInput } from '../../ai-elements/snippet';
import type { Catalog } from './types';
import type { BundledLanguage } from 'shiki';

// Shared shell/json block: shiki-highlighted with a floating copy button,
// squared off to sit inside the newsprint Cards (same treatment as the
// Debug panel's JsonBlock).
function CommandBlock({ code, language }: { code: string; language: BundledLanguage }) {
  return (
    <CodeBlock
      code={code}
      language={language}
      className="rounded-none border-separator-strong [&_code]:text-[12px] [&_pre]:p-3 [&_pre]:text-[12px]"
    >
      <CodeBlockCopyButton className="absolute top-1 right-1 z-10 size-6" />
    </CodeBlock>
  );
}

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
          The station serves MCP over HTTP — no clone, no local process. The endpoint
          mirrors the REST API: read tools work for anyone, DJ-control tools need this station&rsquo;s admin
          credentials passed as an <code>Authorization</code> header. Prefer the HTTP setup below; the stdio
          server is only for local-only use.
        </div>
        <Snippet
          code={mcpUrl}
          className="mt-2.5 h-8 rounded-none border-separator-strong bg-bg"
        >
          <SnippetInput className="text-[12px]" aria-label="MCP endpoint URL" />
          <SnippetAddon align="inline-end">
            <SnippetCopyButton />
          </SnippetAddon>
        </Snippet>
      </Card>

      <Card title="Claude Code (HTTP)" sub="Recommended — connect with a URL">
        <CommandBlock code={httpCmd} language="bash" />
      </Card>

      <Card title="Claude Desktop (HTTP)" sub="Add to claude_desktop_config.json">
        <CommandBlock code={httpJson} language="json" />
      </Card>

      <Card title="Local stdio server" sub="Alternative — runs from a repo clone, no HTTP port exposed">
        <div className="mb-2 text-[11px] leading-[1.6] text-muted">
          Runs the standalone server via <code>tsx</code> straight from the clone (no build step).
        </div>
        <CommandBlock code={stdioCmd} language="bash" />
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
