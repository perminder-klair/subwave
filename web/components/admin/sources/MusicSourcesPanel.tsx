'use client';

// Admin → Music sources (#692): where the station's music comes from. Three
// tabs over one resource (GET /settings/music-source):
//
//   Monitor — the router console: channels, live signal path, service matrix
//             (first, and where the page opens: what is playing, and how)
//   Sources — what the station plays: its Navidrome by default, plus any other
//             source served beside it through the SUB/WAVE music router
//   Plugins — the plugin bay: every module the router can serve from
//
// Moved here from Settings → Music source, whose ?section=music links redirect.

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, Music2, Puzzle, RefreshCw, type LucideIcon } from 'lucide-react';
import { adminJson, useAdminMutation, useAdminQuery } from '../../../lib/admin-query';
import { useAdminAuth } from '../../../lib/adminAuth';
import { errorMessage, notify } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Btn, Card, Eyebrow } from '../ui';
import { SectionTabs } from '../SectionTabs';
import RouterPanel from '../router/RouterPanel';
import { StatusStrip } from '../router/Rack';
import { statusCells, statusLamp } from '../router/model';
import { PluginsTab } from './PluginsTab';
import { SourcesTab } from './SourcesTab';
import { MUSIC_SOURCE_KEY, type MusicSourceView } from './queries';

type TabId = 'sources' | 'plugins' | 'monitor';
const HEALTH_POLL_MS = 30_000;
const TAB_IDS = ['monitor', 'sources', 'plugins'] as const;
const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'monitor', label: 'Monitor', icon: Activity },
  { id: 'sources', label: 'Sources', icon: Music2 },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
];

function servingLine(view: MusicSourceView): string {
  if (view.mode === 'navidrome') return 'Navidrome, connected directly — the music router is bypassed.';
  if (view.failover.active) return 'Navidrome, directly for now — the music router is down and the station fell back to it.';
  const labels = view.sources.map((s) => view.router?.plugins.find((p) => p.name === s.plugin)?.label ?? s.plugin);
  return `${labels.join(' + ')}, through the SUB/WAVE music router${labels.length > 1 ? ' as one merged library' : ''}.`;
}

export default function MusicSourcesPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const queryClient = useQueryClient();
  const query = useAdminQuery<MusicSourceView>({
    key: MUSIC_SOURCE_KEY,
    adminFetch,
    enabled: hydrated && !needsAuth,
    // Health asks every serving backend for its counts, so it is not polled hard.
    refetchInterval: () => HEALTH_POLL_MS,
    request: (fetcher, signal) => adminJson<MusicSourceView>(fetcher, '/settings/music-source', undefined, signal),
  });
  const view = query.data;
  const statusError = query.isError ? errorMessage(query.error) : null;
  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: MUSIC_SOURCE_KEY, exact: true });
  }, [queryClient]);
  const rescan = useAdminMutation<unknown, void>({
    adminFetch,
    request: (_vars, fetcher) => adminJson(fetcher, '/settings/music-source/rescan', { method: 'POST' }),
    onDone: async (_data, _vars, client) => {
      await client.invalidateQueries({ queryKey: MUSIC_SOURCE_KEY, exact: true });
      notify.ok('Plugins rescanned');
    },
  });

  // The active tab lives in the URL (?tab=…), read every render (as Connect and
  // Imaging do): the sidebar carries these tabs as sub-items, and a soft nav to
  // the same pathname does not remount.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as readonly string[]).includes(rawTab ?? '') ? (rawTab as TabId) : 'monitor';
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  if (query.isError && !view) {
    return (
      <div className="grid gap-4">
        <Card title="Music sources"><ErrorState error={errorMessage(query.error)} /></Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="grid gap-3 border-b border-ink p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Eyebrow className="text-vermilion">music sources</Eyebrow>
              <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">Where the station&apos;s music comes from.</div>
              <div className="mt-1 text-[11px] leading-[1.6] text-muted">
                {view ? <>Playing from {servingLine(view)}</> : 'Loading…'} Every track pick, cover and library lookup follows
                this choice, and changes apply immediately — no restart.
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn sm onClick={() => void query.refetch()} disabled={query.isFetching}>
                <RefreshCw aria-hidden="true" className={cn(query.isFetching && 'animate-spin')} />
                Re-check health
              </Btn>
              <Btn sm onClick={() => rescan.mutate()} disabled={rescan.isPending || !view?.router}>
                {rescan.isPending ? 'Rescanning…' : 'Rescan plugins'}
              </Btn>
            </div>
          </div>
          <StatusStrip lamp={statusLamp(view, statusError)} cells={statusCells(view, statusError)} />
        </div>
        <SectionTabs tabs={TABS} value={tab} onChange={selectTab} label="Music source sections" />
      </section>

      {tab === 'monitor' ? (
        <RouterPanel />
      ) : !view ? (
        <Card title="Music sources"><SkeletonRows rows={3} /></Card>
      ) : tab === 'plugins' ? (
        <PluginsTab view={view} />
      ) : (
        <SourcesTab view={view} adminFetch={adminFetch} reload={reload} />
      )}
    </div>
  );
}
