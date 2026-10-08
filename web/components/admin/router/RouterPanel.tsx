'use client';

// Admin → Music sources → Monitor: the SUB/WAVE music router's control center. Source
// channels (every plugin, its health, counts, latency and capabilities), the
// Signal path monitor (the station's live Subsonic traffic and which source
// answered it), and the service matrix (which endpoints each source backs).
//
// Read-only on purpose. Choosing what serves is the Sources tab, whose
// save validates the draft, writes the router's config and re-links the
// library when track ids change — a second switch here would skip all three.

import { useMemo, useState } from 'react';
import { Radio } from 'lucide-react';
import { adminJson, useAdminQuery } from '../../../lib/admin-query';
import { useAdminAuth } from '../../../lib/adminAuth';
import { errorMessage } from '../../../lib/notify';
import { V3Alert } from '../../ui/alert';
import type { RouterActivity } from '../../../lib/schemas.generated';
import { MUSIC_SOURCE_KEY, ROUTER_ACTIVITY_KEY } from '../sources/queries';
import { buildChannels, type RouterView } from './model';
import { ServiceMatrix } from './ServiceMatrix';
import { SignalPath } from './SignalPath';
import { SourceChannels } from './SourceChannels';
import { RackPanel } from './Rack';
import s from './router.module.css';

const ACTIVITY_POLL_MS = 1_500;

export default function RouterPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const enabled = hydrated && !needsAuth;
  const [paused, setPaused] = useState(false);

  // The page header (MusicSourcesPanel) owns this resource's polling and the
  // re-check / rescan keys; the Monitor reads the same cache entry.
  const statusQuery = useAdminQuery<RouterView>({
    key: MUSIC_SOURCE_KEY,
    adminFetch,
    enabled,
    request: (fetcher, signal) => adminJson<RouterView>(fetcher, '/settings/music-source', undefined, signal),
  });
  const view = statusQuery.data;
  const routerUp = Boolean(view?.router);

  const activityQuery = useAdminQuery<RouterActivity>({
    key: ROUTER_ACTIVITY_KEY,
    adminFetch,
    enabled: enabled && routerUp && !paused,
    staleTime: 0,
    refetchInterval: () => ACTIVITY_POLL_MS,
    request: (fetcher, signal) => adminJson<RouterActivity>(fetcher, '/settings/music-source/activity', undefined, signal),
  });


  const channels = useMemo(() => (view ? buildChannels(view) : []), [view]);
  const backends = channels.filter((c) => c.kind === 'source');

  const statusError = statusQuery.isError ? errorMessage(statusQuery.error) : null;

  return (
    <div className={s.console}>

      {statusError && (
        <V3Alert tone="error" title="could not load the router status">{statusError}</V3Alert>
      )}
      {view?.routerError && (
        <V3Alert tone="error" title="music router unreachable">{view.routerError}</V3Alert>
      )}
      {view?.router?.configError && (
        <V3Alert tone="error" title="the router kept its previous source">{view.router.configError}</V3Alert>
      )}

      <RackPanel
        title="Source channels"
        description="Every plugin the router can serve from. Serving channels feed the station; with several merged, the bus is what the station hears."
        flush
      >
        {view ? <SourceChannels channels={channels} /> : <div className={s.skeleton} />}
      </RackPanel>

      <RackPanel
        title="Signal path"
        description="The station's real Subsonic requests travelling through the router: which source answered, how long it took, and why one failed."
      >
        {view?.router ? (
          <SignalPath
            activity={activityQuery.data}
            backends={backends}
            connected={activityQuery.isSuccess && !activityQuery.isError}
            paused={paused}
            onPausedChange={setPaused}
            error={activityQuery.isError ? errorMessage(activityQuery.error) : null}
          />
        ) : view ? (
          <p className={s.empty}>The monitor needs the router. {view.routerError ?? ''}</p>
        ) : (
          <div className={s.skeleton} />
        )}
      </RackPanel>

      <RackPanel
        title="Service matrix"
        description="Which Subsonic endpoints each source fully backs. A source missing an op still plays — the station just gets less from that endpoint."
      >
        {view?.router ? <ServiceMatrix endpoints={view.router.endpoints} channels={channels} /> : <div className={s.skeleton} />}
      </RackPanel>

      <footer className={s.footer}>
        <Radio aria-hidden="true" />
        SUB/WAVE / MUSIC ROUTER / UNIT 01 / LIVE DIAGNOSTICS
      </footer>
    </div>
  );
}
