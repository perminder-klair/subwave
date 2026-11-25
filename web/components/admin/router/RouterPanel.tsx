'use client';

// Admin → Music source (/admin/music): where the station's music comes from,
// and the SUB/WAVE music router's live diagnostics, as tabs
// (?tab=source|channels|signal|matrix, shared with the sidebar submenu, as on
// Imaging and Moods).
//
//   Source          choose and configure the library (music/SourceTab.tsx):
//                   the one place a selection is tested, confirmed and saved
//   Source channels every plugin, its health, counts, latency, capabilities
//   Signal path     the station's live Subsonic traffic, which source answered
//   Service matrix  which endpoints each source backs
//
// The diagnostic tabs are read-only: a second way to switch would skip the
// Source tab's test, confirmation and re-link progress.

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, Cable, Grid3x3, Music2, Radio, RefreshCw } from 'lucide-react';
import { adminJson, useAdminMutation, useAdminQuery } from '../../../lib/admin-query';
import { useAdminAuth } from '../../../lib/adminAuth';
import { errorMessage, notify } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import { buttonVariants } from '../../ui/button';
import { V3Alert } from '../../ui/alert';
import { Btn } from '../ui';
import { SectionTabs } from '../SectionTabs';
import type { RouterActivity } from '../../../lib/schemas.generated';
import { MUSIC_SOURCE_KEY, type MusicSourceView } from '../music/queries';
import { SourceTab } from '../music/SourceTab';
import { buildChannels, type RouterView } from './model';
import { ServiceMatrix } from './ServiceMatrix';
import { SignalPath } from './SignalPath';
import { SourceChannels } from './SourceChannels';
import s from './router.module.css';

/** The live feed, polled only while this page is open. Nests under the music-source family. */
export const ROUTER_ACTIVITY_KEY = [...MUSIC_SOURCE_KEY, 'activity'] as const;

const ACTIVITY_POLL_MS = 1_500;
// Health asks every serving backend for its library counts, so it is not polled hard.
const HEALTH_POLL_MS = 30_000;

type TabId = 'source' | 'channels' | 'signal' | 'matrix';
const TAB_IDS: TabId[] = ['source', 'channels', 'signal', 'matrix'];

/** Direct Navidrome: say once, under the faceplate, that the router is on standby. */
function StandbyStrip({ onChoose }: { onChoose: () => void }) {
  return (
    <div className={s.standby} role="status">
      <span className={s.powerLamp} data-state="idle" aria-hidden="true" />
      <div className="min-w-0">
        <strong>Router on standby</strong>
        <p>
          The station plays Navidrome directly, so nothing goes through the router. Pick a source to route the
          station through it; until then these views show what the router could serve, not what is on air.
        </p>
      </div>
      <button type="button" onClick={onChoose} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Choose a source
      </button>
    </div>
  );
}

function Screws() {
  return (
    <>
      <span className={s.screw} data-at="tl" aria-hidden="true" />
      <span className={s.screw} data-at="tr" aria-hidden="true" />
    </>
  );
}

function RackPanel({
  title,
  description,
  action,
  flush,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={s.rack} aria-label={title}>
      <Screws />
      <div className={s.rackHeader}>
        <div className="min-w-0">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action && <div className={s.rackActions}>{action}</div>}
      </div>
      <div className={flush ? s.rackBodyFlush : s.rackBody}>{children}</div>
    </section>
  );
}

type Tone = 'ok' | 'idle' | 'error' | undefined;
interface Cell {
  label: string;
  value: string;
  tone?: Tone;
  wide?: boolean;
}

/** The faceplate's display: one labelled cell per fact, never one run-on line. */
function readoutCells(view: RouterView | undefined, linkError: boolean, checkedAt: number): Cell[] {
  if (!view) {
    return [{ label: 'Link', value: linkError ? 'No link to the controller' : 'Establishing link…', tone: linkError ? 'error' : undefined, wide: true }];
  }
  const r = view.router;
  const direct = view.mode === 'navidrome';
  const serving = direct ? 'Navidrome' : r?.serving ? r.serving.label : 'Nothing';
  const cells: Cell[] = [
    { label: 'Mode', value: direct ? 'Direct' : view.merge ? 'Routed, merged' : 'Routed', tone: direct ? 'idle' : 'ok' },
    { label: 'Station plays', value: serving, tone: !direct && !r?.serving ? 'error' : undefined, wide: true },
  ];
  if (!r) {
    cells.push({ label: 'Router', value: 'Unreachable', tone: 'error' });
  } else {
    cells.push(
      { label: 'Router', value: `v${r.router.version}` },
      { label: 'Plugin API', value: `v${r.router.apiVersion}` },
      { label: 'Plugins', value: String(r.plugins.length) },
      { label: 'Endpoints', value: String(r.endpoints.length) },
    );
  }
  if (checkedAt) {
    cells.push({ label: 'Checked', value: new Date(checkedAt).toLocaleTimeString('en-GB') });
  }
  return cells;
}

export default function RouterPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const enabled = hydrated && !needsAuth;
  const [paused, setPaused] = useState(false);

  const nav = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = (TAB_IDS as string[]).includes(rawTab ?? '') ? (rawTab as TabId) : 'source';
  // Routed through Next so a soft nav (in-page tab or sidebar submenu) re-derives `tab`.
  const selectTab = useCallback(
    (id: string) => {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.set('tab', id);
      nav.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [nav, pathname, searchParams],
  );

  const statusQuery = useAdminQuery<MusicSourceView>({
    key: MUSIC_SOURCE_KEY,
    adminFetch,
    enabled,
    refetchInterval: () => HEALTH_POLL_MS,
    request: (fetcher, signal) => adminJson<MusicSourceView>(fetcher, '/settings/music-source', undefined, signal),
  });
  const view = statusQuery.data;
  const routerUp = Boolean(view?.router);

  const activityQuery = useAdminQuery<RouterActivity>({
    key: ROUTER_ACTIVITY_KEY,
    adminFetch,
    enabled: enabled && routerUp && !paused && tab === 'signal',
    staleTime: 0,
    refetchInterval: () => ACTIVITY_POLL_MS,
    request: (fetcher, signal) => adminJson<RouterActivity>(fetcher, '/settings/music-source/activity', undefined, signal),
  });

  const rescan = useAdminMutation<unknown, void>({
    adminFetch,
    request: (_vars, fetcher) => adminJson(fetcher, '/settings/music-source/rescan', { method: 'POST' }),
    onDone: async (_data, _vars, client) => {
      await client.invalidateQueries({ queryKey: MUSIC_SOURCE_KEY, exact: true });
      notify.ok('Plugins rescanned');
    },
  });

  const channels = useMemo(() => (view ? buildChannels(view) : []), [view]);
  const backends = channels.filter((c) => c.kind === 'source');

  const lamp = statusQuery.isError || view?.routerError || view?.router?.configError ? 'error' : view?.mode === 'navidrome' ? 'idle' : 'ok';
  const statusError = statusQuery.isError ? errorMessage(statusQuery.error) : null;

  return (
    <div className={s.console}>
      <header className={s.faceplate}>
        <Screws />
        <span className={s.screw} data-at="bl" aria-hidden="true" />
        <span className={s.screw} data-at="br" aria-hidden="true" />
        <div className={s.faceplateTop}>
          <div className={s.brand}>
            <span className={s.powerLamp} data-state={lamp} aria-hidden="true" />
            <div>
              <h1>MUSIC SOURCE</h1>
              <p>Library / router / live diagnostics</p>
            </div>
          </div>
          <div className={s.faceplateActions}>
            <Btn sm onClick={() => void statusQuery.refetch()} disabled={statusQuery.isFetching}>
              <RefreshCw aria-hidden="true" className={cn(statusQuery.isFetching && 'animate-spin')} />
              Re-check health
            </Btn>
            <Btn sm onClick={() => rescan.mutate()} disabled={rescan.isPending || !routerUp}>
              {rescan.isPending ? 'Rescanning…' : 'Rescan plugins'}
            </Btn>
          </div>
        </div>
        <dl className={s.lcd}>
          {readoutCells(view, Boolean(statusError), statusQuery.dataUpdatedAt).map((c) => (
            <div key={c.label} className={s.lcdCell} data-tone={c.tone} data-wide={c.wide || undefined}>
              <dt>{c.label}</dt>
              <dd>{c.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {statusError && (
        <V3Alert tone="error" title="could not load the router status">{statusError}</V3Alert>
      )}
      {/* The Source tab says these in its own words, and only when they matter there. */}
      {tab !== 'source' && view?.routerError && (
        <V3Alert tone="error" title="music router unreachable">{view.routerError}</V3Alert>
      )}
      {tab !== 'source' && view?.router?.configError && (
        <V3Alert tone="error" title="the router kept its previous source">{view.router.configError}</V3Alert>
      )}

      {view?.mode === 'navidrome' && tab !== 'source' && <StandbyStrip onChoose={() => selectTab('source')} />}

      {/* SectionTabs draws only its top rule; the rack card gives it a ground. */}
      <div className={s.tabs}>
        <SectionTabs
          tabs={[
            { id: 'source', label: 'Source', icon: Music2 },
            { id: 'channels', label: 'Source channels', count: view ? channels.length : undefined, icon: Cable },
            { id: 'signal', label: 'Signal path', icon: Activity },
            { id: 'matrix', label: 'Service matrix', count: view?.router?.endpoints.length, icon: Grid3x3 },
          ]}
          value={tab}
          onChange={selectTab}
          label="Music router sections"
        />
      </div>

      {tab === 'source' && (
        <SourceTab adminFetch={adminFetch} view={view} viewError={statusError} />
      )}

      {tab === 'channels' && (
        <RackPanel
          title="Source channels"
          description="Every plugin the router can serve from. Serving channels feed the station; with several merged, the bus is what the station hears."
          flush
        >
          {view ? <SourceChannels channels={channels} /> : <div className={s.skeleton} />}
        </RackPanel>
      )}

      {tab === 'signal' && (
        <RackPanel
          title="Signal path"
          description="The station's real Subsonic requests travelling through the router: which source answered, how long it took, and why one failed."
        >
          {view?.router ? (
            <div className={s.overlayHost}>
              <SignalPath
                activity={activityQuery.data}
                backends={backends}
                connected={activityQuery.isSuccess && !activityQuery.isError}
                paused={paused}
                onPausedChange={setPaused}
                error={activityQuery.isError ? errorMessage(activityQuery.error) : null}
              />
              {view.mode === 'navidrome' && !activityQuery.data?.requests?.length && (
                <div className={s.overlay} role="status">
                  <strong>No signal</strong>
                  <p>The station talks to Navidrome directly, so nothing passes through the router to monitor.</p>
                </div>
              )}
            </div>
          ) : view ? (
            <p className={s.empty}>The monitor needs the router. {view.routerError ?? ''}</p>
          ) : (
            <div className={s.skeleton} />
          )}
        </RackPanel>
      )}

      {tab === 'matrix' && (
        <RackPanel
          title="Service matrix"
          description="Which Subsonic endpoints each source fully backs. A source missing an op still plays — the station just gets less from that endpoint."
        >
          {view?.router ? <ServiceMatrix endpoints={view.router.endpoints} channels={channels} /> : <div className={s.skeleton} />}
        </RackPanel>
      )}

      <footer className={s.footer}>
        <Radio aria-hidden="true" />
        SUB/WAVE / MUSIC SOURCE / UNIT 01 / LIVE DIAGNOSTICS
      </footer>
    </div>
  );
}
