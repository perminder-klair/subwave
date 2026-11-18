import type { DebugLlm } from './types';

type Routing = NonNullable<DebugLlm['routedToBackup']>;

const ago = (ms: number) => {
  const mins = Math.floor(ms / 60_000);
  return mins < 1 ? 'under a minute ago' : `${mins} min ago`;
};

// The tooltip, one fact per sentence: why, how much, whether the backup is
// coping, and when the primary gets its next try. The controller decides all
// of it on every /debug read; this only phrases it. `now` is a parameter so
// the wording can be tested.
export function backupRouteTitle(r: Routing, now: number = Date.now()): string {
  const parts = [r.reason || 'primary not used'];
  if (typeof r.calls === 'number' && typeof r.since === 'number') {
    const mins = Math.floor((now - r.since) / 60_000);
    parts.push(`${r.calls} call${r.calls === 1 ? '' : 's'} to the backup in the last ${mins < 1 ? 'minute' : `${mins} min`}`);
  }
  if (typeof r.lastAt === 'number') parts.push(`last one ${ago(now - r.lastAt)}`);
  if (r.lastOk === false) parts.push('the backup failed too on the last call');
  if (typeof r.retryPrimaryAt === 'number') {
    const mins = Math.max(1, Math.ceil((r.retryPrimaryAt - now) / 60_000));
    parts.push(`primary tried again in about ${mins} min`);
  } else {
    parts.push('the next call tries the primary first');
  }
  return parts.join(' · ');
}

// Inline note on the "LLM recent calls" subtitle whenever calls are going to
// the backup instead of the primary, whatever the cause (N2). The dot borrows
// the Dash "On Air" LIVE lamp's colour: the theme accent with its glow.
// Nothing renders under normal routing, so the subtitle returns to its plain
// form as soon as the primary answers again.
export default function BackupRouteNote({ routing }: { routing?: DebugLlm['routedToBackup'] }) {
  if (!routing) return null;
  const label = [routing.provider, routing.model].filter(Boolean).join(' / ') || 'backup';
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 whitespace-normal" title={backupRouteTitle(routing)}>
      <span
        aria-hidden="true"
        className="inline-block size-[7px] shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_6px_1px_color-mix(in_oklab,var(--accent)_70%,transparent)]"
      />
      <span className="min-w-0 wrap-anywhere">routed to backup {label}</span>
    </span>
  );
}
