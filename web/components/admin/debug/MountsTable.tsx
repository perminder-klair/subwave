'use client';

import type { DebugMount, DebugMounts } from './types';

function MountStatus({ m }: { m: DebugMount }) {
  const [label, color] = m.live
    ? ['live', 'text-emerald-500']
    : m.configured
      ? ['down', 'text-red-500']
      : ['off', 'text-muted'];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${color}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export function MountsTable({ mounts }: { mounts?: DebugMounts }) {
  if (!mounts) return null;
  return (
    <div className="mt-4 grid gap-3">
      <div className="grid gap-1.5">
        <div className="field-hint tracking-wide uppercase">Listen mounts</div>
        {mounts.list.map(m => (
          <div key={m.path} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[12px]">
            <span className="flex min-w-0 items-center gap-2">
              <MountStatus m={m} />
              <span className="font-medium">{m.codec}</span>
              <code className="truncate text-[11px] text-muted">{m.path}</code>
            </span>
            <span className="text-right text-[11px] text-muted">
              {m.live
                ? `${m.note ?? (m.bitrate ? `${m.bitrate} kbps` : m.codec === 'FLAC' ? 'lossless' : '—')} · ${
                    // HLS listeners are counted off the edge's playlist log; null
                    // there means "not counted", which is not the same as 0.
                    m.listeners == null && m.note ? 'not counted' : `${m.listeners ?? 0} ${m.listeners === 1 ? 'listener' : 'listeners'}`
                  }${
                    m.sampleRate ? ` · ${(m.sampleRate / 1000).toFixed(1)}k` : ''
                  }`
                : m.configured
                  ? 'enabled · no source (restart mixer?)'
                  : m.blockedReason
                    ? `held back — ${m.blockedReason}`
                    : 'disabled'}
            </span>
          </div>
        ))}
      </div>
      <div className="grid gap-1">
        <div className="field-hint tracking-wide uppercase">
          Tune-in files · {mounts.tuneIn.entryCount}{' '}
          {mounts.tuneIn.entryCount === 1 ? 'mount' : 'mounts'}
        </div>
        <code className="text-[11px] break-all text-muted">{mounts.tuneIn.pls}</code>
        <code className="text-[11px] break-all text-muted">{mounts.tuneIn.m3u}</code>
      </div>
    </div>
  );
}

// Slugs like "early-morning" / "drive-time" → "Early morning".
export function titleize(s: unknown): string {
  const t = String(s ?? '').replace(/[-_]/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

