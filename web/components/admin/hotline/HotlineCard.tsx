'use client';

// The dashboard's Hotline card (docs/plans/hotline.md, "Operator surfaces"):
// the line's state, the Call on it with an end button, the day's minutes
// against the cap, recent Call outcomes with a ban button, and the bans.
// Operators can't listen in: the audio never passes through the controller.
import { useAdminAuth } from '../../../lib/adminAuth';
import { Card, Btn, Pill } from '../ui';
import { useHotlineAdminQuery, useHotlineCommand, type HotlineAdmin } from './queries';

const CLOSED_COPY: Record<NonNullable<HotlineAdmin['reason']>, string> = {
  provider: 'closed: no OpenAI key set (Settings → LLM → keys)',
  requests: 'closed: requests are off',
  show: 'closed: the show on air does not open it',
  minutes: "closed: today's minutes are used up",
};

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function HotlineCard() {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const query = useHotlineAdminQuery(adminFetch, { enabled: hydrated && !needsAuth, poll: true });
  const command = useHotlineCommand(adminFetch);
  const d = query.data;
  if (!d) return null;
  // A station that has never had a Hotline show or key gets no card at all.
  if (!d.providerReady && !d.recent.length && !d.bans.length) return null;

  const usedMin = Math.round(d.today.secondsUsed / 60);
  const sub = d.state === 'closed' && d.reason ? CLOSED_COPY[d.reason] : d.state === 'busy' ? 'a caller is on the line' : 'open: listeners can ring the DJ';

  return (
    <Card
      title="Hotline"
      sub={`${sub} · ${usedMin} / ${d.today.dailyMinutes} min today`}
      right={<Pill tone={d.state === 'busy' ? 'accent' : undefined} dot>{d.state}</Pill>}
    >
      <div className="grid gap-3">
        {d.call && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-separator-strong p-3">
            <div className="text-sm">
              <div className="font-semibold">On the line: {d.call.name === 'anon' ? 'an unnamed caller' : d.call.name}</div>
              <div className="text-muted">
                {mmss(d.call.elapsedSec)} / {mmss(d.call.capSec)}
                {d.call.granted ? ` · granted “${d.call.granted.title}” — ${d.call.granted.artist}` : d.call.declined ? ' · declined' : ''}
              </div>
            </div>
            <Btn tone="danger" sm disabled={command.isPending} onClick={() => command.mutate({ kind: 'end' })}>End call</Btn>
          </div>
        )}

        {d.recent.length > 0 && (
          <div className="grid gap-1.5">
            <div className="text-xs tracking-wide text-muted uppercase">Recent calls</div>
            {d.recent.slice(0, 10).map(r => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{r.name === 'anon' ? 'unnamed' : r.name}</span>
                  <span className="text-muted"> · {mmss(r.durationSec)} · {r.outcome}{r.track ? ` · ${r.track}` : ''}{r.endedBy === 'cap' ? ' · cut at the limit' : ''}</span>
                </span>
                <Btn sm disabled={command.isPending} onClick={() => command.mutate({ kind: 'ban', callId: r.id })}>Ban device</Btn>
              </div>
            ))}
          </div>
        )}

        {d.bans.length > 0 && (
          <div className="grid gap-1.5">
            <div className="text-xs tracking-wide text-muted uppercase">Hotline bans · best-effort, by device and address</div>
            {d.bans.map(b => (
              <div key={b.id} className="flex items-center justify-between gap-2 text-sm">
                <span>{b.name && b.name !== 'anon' ? b.name : 'unnamed caller'} <span className="text-muted">· since {b.at.slice(0, 10)}</span></span>
                <Btn sm disabled={command.isPending} onClick={() => command.mutate({ kind: 'unban', banId: b.id })}>Lift ban</Btn>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
