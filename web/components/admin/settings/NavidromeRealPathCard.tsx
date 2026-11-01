'use client';

import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '@/lib/admin-query';
import { notify } from '@/lib/notify';
import { Label } from '../../ui/label';
import { Btn, Card, Pill, Seg } from '../ui';

// Navidrome's "Report Real Path" on SUB/WAVE's own player rows. Without it
// Navidrome sends a `path` built from the tags rather than the file on disk.
// The controller reads and switches the rows (routes/settings/core.ts,
// music/navidrome-players.ts); this card shows them, offers a one-off switch
// and the opt-in that keeps them on. Reading them logs in to Navidrome with the
// station's password, so with the opt-in off opening the card reads nothing and
// the rows wait for "Check status". The setting is Navidrome's own, so on any
// other Subsonic server the card shrinks to one line and offers nothing.

type RealPathState = 'on' | 'off' | 'not-read' | 'no-players' | 'refused' | 'not-navidrome' | 'unavailable';

interface RealPathView {
  state: RealPathState;
  reason: string | null;
  server: { type: string; version: string | null } | null;
  switched: number;
  autoEnable: boolean;
  players: { client: string; userAgent: string; reportRealPath: boolean; lastSeen: string | null }[];
}

const realPathKey = ['settings', 'navidrome', 'players'] as const;

const STATE_TEXT: Record<RealPathState, string> = {
  on: 'Every SUB/WAVE player reports real paths.',
  off: 'Some SUB/WAVE players still send tag-built paths.',
  'not-read': "Not checked. While the setting below is off, SUB/WAVE stays out of Navidrome's own API until you ask.",
  'no-players': 'Navidrome has no SUB/WAVE player yet — it appears after the first request.',
  refused: 'Navidrome refused the change for this account. Tick it by hand in Navidrome → Settings → Players.',
  'not-navidrome': 'Report Real Path is a Navidrome setting; there is nothing to switch on this music server.',
  unavailable: "Navidrome's player list can't be read",
};

export function NavidromeRealPathCard({ adminFetch }: { adminFetch: AdminFetch }) {
  const query = useAdminQuery<RealPathView>({
    key: realPathKey,
    adminFetch,
    request: (fetcher, signal) => adminJson<RealPathView>(fetcher, '/settings/navidrome/players', undefined, signal),
    toastOnError: false,
  });

  const checkNow = useAdminMutation<RealPathView, void>({
    adminFetch,
    request: (_vars, fetcher) =>
      adminJson<RealPathView>(fetcher, '/settings/navidrome/players/check', { method: 'POST' }),
    onDone: (view, _vars, client) => { client.setQueryData(realPathKey, view); },
  });

  const switchNow = useAdminMutation<RealPathView, void>({
    adminFetch,
    request: (_vars, fetcher) =>
      adminJson<RealPathView>(fetcher, '/settings/navidrome/players/real-path', { method: 'POST' }),
    onDone: (view, _vars, client) => {
      client.setQueryData(realPathKey, view);
      if (view.switched) notify.ok(`Report Real Path switched on for ${view.switched} player(s)`);
    },
  });

  // Saving the opt-in ON also switches the rows now, rather than at the next
  // hourly pass.
  const setAuto = useAdminMutation<RealPathView | null, boolean>({
    adminFetch,
    request: async (on, fetcher) => {
      await adminJson(fetcher, '/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ musicSource: { reportRealPath: on } }),
      });
      return on
        ? adminJson<RealPathView>(fetcher, '/settings/navidrome/players/real-path', { method: 'POST' })
        : null;
    },
    onDone: async (view, on, client) => {
      if (view) client.setQueryData(realPathKey, view);
      else await client.invalidateQueries({ queryKey: realPathKey });
      // Saved on the click, with no save bar, so say so.
      notify.ok(on
        ? `Saved: Report Real Path kept on${view?.switched ? ` (${view.switched} player(s) switched on now)` : ''}`
        : 'Saved: Report Real Path no longer kept on');
    },
  });

  const view = query.data;
  const busy = checkNow.isPending || switchNow.isPending || setAuto.isPending;
  const canSwitch = view?.state === 'off' || view?.state === 'refused';
  const canCheck = view !== undefined && !view.autoEnable;

  if (view?.state === 'not-navidrome') {
    const name = view.server?.type
      ? [view.server.type, view.server.version].filter(Boolean).join(' ')
      : 'this server';
    return (
      <Card title="Real file paths" sub="navidrome only">
        <div className="text-[12px] leading-[1.5]">
          {STATE_TEXT['not-navidrome']} Your music server is <b>{name}</b>.
        </div>
      </Card>
    );
  }

  return (
    <Card title="Real file paths" sub="navidrome · report real path">
      <div className="grid gap-[18px]">
        <div className="field">
          <Label>Status</Label>
          {query.isPending ? (
            <div className="field-hint">Reading Navidrome&apos;s players…</div>
          ) : !view ? (
            <div className="field-hint">Could not read the players from the controller.</div>
          ) : (
            <>
              <div className="text-[12px] leading-[1.5]">
                {STATE_TEXT[view.state]}
                {view.state === 'unavailable' && view.reason ? ` (${view.reason}).` : ''}
              </div>
              {view.players.length > 0 && (
                <ul className="mt-2 grid gap-1 text-[12px]">
                  {view.players.map(p => (
                    <li key={`${p.client}|${p.userAgent}`} className="flex items-center gap-2">
                      <Pill tone={p.reportRealPath ? 'accent' : 'ink'}>{p.reportRealPath ? 'on' : 'off'}</Pill>
                      <span>{p.client}</span>
                      {p.userAgent && <span className="text-muted">{p.userAgent}</span>}
                      {p.lastSeen && <span className="text-muted">· seen {p.lastSeen.slice(0, 10)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="field-hint">
            Navidrome keeps one player per SUB/WAVE component (controller, analyzer, mixer) and
            starts each new one with &quot;Report Real Path&quot; off, so the file paths it sends
            are built from the tags. A mounted library (<code>MUSIC_LIBRARY_PATH</code>) finds its
            files from a tag-built path only when its folders match the tags; the real path finds
            them however they&apos;re laid out. The controller and broadcast containers both need
            the library, at the same path. Until the mixer can read it, or for any file it
            can&apos;t find, the track plays from the stream. Only SUB/WAVE&apos;s own players on
            this account are ever changed.
          </div>
        </div>

        <div className="field">
          <Label>Keep Report Real Path on</Label>
          <Seg
            value={view?.autoEnable ? 'on' : 'off'}
            onChange={v => { if (!busy) setAuto.mutate(v === 'on'); }}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
          />
          <div className="field-hint">
            {setAuto.isPending ? 'Saving… ' : 'Saved as soon as you click. '}
            Checks SUB/WAVE&apos;s players every hour and at start-up, and switches on any that are
            off. Off by default, because it changes your Navidrome&apos;s settings.
          </div>
        </div>

        {(canCheck || canSwitch) && (
          <div className="field">
            <div className="flex flex-wrap gap-2">
              {canCheck && (
                <Btn sm onClick={() => checkNow.mutate()} disabled={busy}>
                  {checkNow.isPending ? 'Checking…' : 'Check status'}
                </Btn>
              )}
              {canSwitch && (
                <Btn sm tone="accent" onClick={() => switchNow.mutate()} disabled={busy}>
                  {switchNow.isPending ? 'Switching…' : 'Turn on now'}
                </Btn>
              )}
            </div>
            {canCheck && (
              <div className="field-hint">Check status signs in to Navidrome once with the station&apos;s password.</div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
