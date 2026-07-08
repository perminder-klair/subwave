'use client';

/* Admin Connect page — the API discovery surface. Four tabs:
   - Endpoints: the curated HTTP API, each with an inline playground.
   - MCP: the subwave-mcp tool set + copy-ready client setup.
   - Integrations: stream URLs, now-playing feeds, and Home Assistant /
     Music Assistant recipes.
   - Webhooks: outbound event POSTs (the push direction).

   All of it renders from GET /connect/catalog (controller/src/routes/connect.ts),
   which carries the manifest plus the live station origin + per-mount enabled
   state, so URLs shown here are the real, copy-ready absolute URLs. */

import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { Card, Btn, Eyebrow, Seg } from '../ui';
import type { Catalog } from './types';
import EndpointsTab from './EndpointsTab';
import McpTab from './McpTab';
import IntegrationsTab from './IntegrationsTab';
import WebhooksPanel from '../WebhooksPanel';

type TabId = 'endpoints' | 'mcp' | 'integrations' | 'webhooks';

const TABS: { id: TabId; label: string }[] = [
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'mcp', label: 'MCP' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'webhooks', label: 'Webhooks' },
];

export default function ConnectPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('endpoints');

  // Deep-link: /admin/connect?tab=mcp opens that tab directly (mirrors
  // /admin/settings?section=…).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'endpoints' || t === 'mcp' || t === 'integrations' || t === 'webhooks') setTab(t);
  }, []);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/connect/catalog');
        if (!r.ok) throw new Error(`controller error (${r.status})`);
        const data = (await r.json()) as Catalog;
        if (!cancelled) { setCatalog(data); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr(errorMessage(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth, adminFetch]);

  const selectTab = useCallback((id: string) => {
    setTab(id as TabId);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', id);
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  const downloadOpenApi = useCallback(async () => {
    if (!catalog) return;
    try {
      const r = await adminFetch(catalog.openapiPath);
      if (!r.ok) throw new Error(`controller error (${r.status})`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'subwave-openapi.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      notify.ok('OpenAPI spec downloaded');
    } catch (e) {
      notify.err(errorMessage(e));
    }
  }, [adminFetch, catalog]);

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Connect"><div className="text-[13px] text-[var(--danger)]">controller error: {err}</div></Card>
      </div>
    );
  }
  if (!catalog) {
    return (
      <div className="grid gap-4">
        <Card title="Connect"><div className="text-[13px] text-muted italic">loading…</div></Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">connect</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            Everything wired to {catalog.station}.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Discover the HTTP API, try it live, wire up an MCP client, or point a speaker at the stream.
            All URLs below are the real addresses for this station (<code>{catalog.origin}</code>).
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
          <Seg
            value={tab}
            options={TABS.map(t => ({ id: t.id, label: t.label }))}
            accent
            onChange={selectTab}
          />
          <span className="ml-auto" />
          <Btn sm onClick={downloadOpenApi} title="Download an OpenAPI 3.1 spec for this station">
            Download OpenAPI
          </Btn>
        </div>
      </section>

      {tab === 'endpoints' && <EndpointsTab catalog={catalog} adminFetch={adminFetch} />}
      {tab === 'mcp' && <McpTab catalog={catalog} />}
      {tab === 'integrations' && <IntegrationsTab catalog={catalog} />}
      {tab === 'webhooks' && <WebhooksPanel />}
    </div>
  );
}
