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
import type { LucideIcon } from 'lucide-react';
import { Braces, Boxes, Cable, Webhook } from 'lucide-react';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Card, Btn, Eyebrow } from '../ui';
import { SectionTabs } from '../SectionTabs';
import type { Catalog } from './types';
import EndpointsTab from './EndpointsTab';
import McpTab from './McpTab';
import IntegrationsTab from './IntegrationsTab';
import WebhooksPanel from '../WebhooksPanel';

type TabId = 'endpoints' | 'mcp' | 'integrations' | 'webhooks';

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'endpoints', label: 'Endpoints', icon: Braces },
  { id: 'mcp', label: 'MCP', icon: Boxes },
  { id: 'integrations', label: 'Integrations', icon: Cable },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
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
        <Card title="Connect"><ErrorState error={err} /></Card>
      </div>
    );
  }
  if (!catalog) {
    return (
      <div className="grid gap-4">
        <Card title="Connect"><SkeletonRows rows={3} /></Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink p-4">
          <div className="min-w-0">
            <Eyebrow className="text-vermilion">connect</Eyebrow>
            <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
              Everything wired to {catalog.station}.
            </div>
            <div className="mt-1 text-[11px] leading-[1.6] text-muted">
              Discover the HTTP API, try it live, wire up an MCP client, or point a speaker at the stream.
              All URLs below are the real addresses for this station (<code>{catalog.origin}</code>).
            </div>
          </div>
          <Btn sm onClick={downloadOpenApi} className="flex-none" title="Download an OpenAPI 3.1 spec for this station">
            Download OpenAPI
          </Btn>
        </div>
        {/* Shared editorial section-tabs, edge-to-edge along the card's foot. */}
        <SectionTabs tabs={TABS} value={tab} onChange={selectTab} label="Connect sections" />
      </section>

      {tab === 'endpoints' && <EndpointsTab catalog={catalog} adminFetch={adminFetch} />}
      {tab === 'mcp' && <McpTab catalog={catalog} />}
      {tab === 'integrations' && <IntegrationsTab catalog={catalog} />}
      {tab === 'webhooks' && <WebhooksPanel />}
    </div>
  );
}
