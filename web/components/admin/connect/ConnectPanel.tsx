'use client';

/* Renders from GET /connect/catalog (controller/src/routes/connect.ts), which carries
   the manifest plus the live station origin + per-mount enabled state, so every URL
   shown here is a real, copy-ready absolute URL. */

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { adminResponse } from '../../../lib/admin-query';
import type { LucideIcon } from 'lucide-react';
import { Braces, Boxes, Radio, Webhook } from 'lucide-react';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Card, Btn, Eyebrow } from '../ui';
import { SectionTabs } from '../SectionTabs';
import EndpointsTab from './EndpointsTab';
import McpTab from './McpTab';
import IntegrationsTab from './IntegrationsTab';
import WebhooksPanel from '../WebhooksPanel';
import { useConnectCatalogQuery } from './queries';

type TabId = 'endpoints' | 'mcp' | 'integrations' | 'webhooks';

const TAB_IDS = ['integrations', 'endpoints', 'mcp', 'webhooks'] as const;

// Stream URLs leads, and is the default. Three "where is the stream URL?"
// reports arrived while this panel already answered it — on the third tab,
// under the word "Integrations", behind a rail entry saying only "Connect"
// (#1300, #1485). The endpoint explorer is the specialist surface; the stream
// address is what an operator opens this page for. Tab IDS are unchanged, so
// every existing /admin/connect?tab=… deep link still resolves.
const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'integrations', label: 'Stream URLs', icon: Radio },
  { id: 'endpoints', label: 'API', icon: Braces },
  { id: 'mcp', label: 'MCP', icon: Boxes },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
];

export default function ConnectPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const catalogQuery = useConnectCatalogQuery(adminFetch, hydrated && !needsAuth);
  const catalog = catalogQuery.data ?? null;

  // The active tab lives in the URL (?tab=…), read every render rather than
  // mirrored into state. Same pattern as ImagingPanel, and for the same reason:
  // the sidebar now carries these tabs as sub-items, and a soft nav to the same
  // pathname does NOT remount, so a mount-only effect would move the URL while
  // leaving the panel on the tab it was already showing. Unknown values fall
  // back to the default rather than rendering nothing.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabId)
    : 'integrations';

  // Routed through Next so an in-page tab press re-derives `tab` the same way a
  // sidebar press does.
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const downloadOpenApi = useCallback(async () => {
    if (!catalog) return;
    try {
      // admin-query-imperative: openapi-download
      const r = await adminResponse(adminFetch, catalog.openapiPath);
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

  if (catalogQuery.error) {
    return (
      <div className="grid gap-4">
        <Card title="Connect"><ErrorState error={errorMessage(catalogQuery.error)} /></Card>
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
              All URLs below are the real addresses for this station (<code className="break-all">{catalog.origin}</code>).
            </div>
          </div>
          <Btn sm onClick={downloadOpenApi} className="flex-none" title="Download an OpenAPI 3.1 spec for this station">
            Download OpenAPI
          </Btn>
        </div>
        <SectionTabs tabs={TABS} value={tab} onChange={selectTab} label="Connect sections" />
      </section>

      {tab === 'endpoints' && <EndpointsTab catalog={catalog} adminFetch={adminFetch} />}
      {tab === 'mcp' && <McpTab catalog={catalog} />}
      {tab === 'integrations' && <IntegrationsTab catalog={catalog} />}
      {tab === 'webhooks' && <WebhooksPanel />}
    </div>
  );
}
