'use client';

// Archives — /admin/archives. The hourly broadcast recordings Liquidsoap
// writes under state/archive/. Read-only: download or delete via the file
// system, no playback controls here (these MP3s are an hour long each and
// the browser audio element doesn't seek well into them).

import { useEffect, useMemo, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { fmtSize, relTime } from '../../lib/format';
import { Card, Btn, Eyebrow, Pill } from './ui';

interface ArchiveEntry {
  path: string;
  date: string;
  hour: number;
  bytes: number;
  mtime: string;
}

interface ArchivesResponse {
  archives?: ArchiveEntry[];
}

function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

export default function ArchivesPanel() {
  const { adminFetch, auth, needsAuth, hydrated } = useAdminAuth();
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/archives');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as ArchivesResponse;
        if (cancelled) return;
        setEntries(Array.isArray(j.archives) ? j.archives : []);
        setErr(null);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth, adminFetch]);

  // Group by date — the operator's mental model is "let me grab yesterday's
  // 9am hour", not "give me a flat list of 720 mp3s sorted by mtime".
  const byDate = useMemo(() => {
    if (!entries) return [] as { date: string; items: ArchiveEntry[]; bytes: number }[];
    const m = new Map<string, ArchiveEntry[]>();
    for (const e of entries) {
      const arr = m.get(e.date) || [];
      arr.push(e);
      m.set(e.date, arr);
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] > b[0] ? -1 : 1))
      .map(([date, items]) => ({
        date,
        items: items.sort((a, b) => b.hour - a.hour),
        bytes: items.reduce((a, b) => a + b.bytes, 0),
      }));
  }, [entries]);

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Archives"><div className="text-[13px] text-[var(--danger)]">controller error: {err}</div></Card>
      </div>
    );
  }
  if (!entries) {
    return (
      <div className="grid gap-4">
        <Card title="Archives"><div className="text-[13px] text-muted italic">loading…</div></Card>
      </div>
    );
  }

  const totalBytes = entries.reduce((a, b) => a + b.bytes, 0);

  // Download links carry HTTP Basic auth in the URL so the <a> can stream
  // directly through Caddy without us pulling the whole file into memory.
  const downloadHref = (path: string) => {
    const base = process.env.NEXT_PUBLIC_API_URL || '/api';
    // auth is base64(user:pass); split it back to inject as userinfo for
    // same-origin URLs the browser will send a normal Authorization header
    // for via fetch — but for a plain anchor download we need the credentials
    // pre-baked. Use the credentials via a fetch-then-blob fallback if base
    // is same-origin; for an external API URL include userinfo.
    if (!base.startsWith('http')) return `${base}/archives/file/${path}`;
    try {
      const u = new URL(`${base}/archives/file/${path}`);
      if (auth) {
        const dec = typeof window !== 'undefined' ? window.atob(auth) : '';
        const [user, pass] = dec.split(':');
        if (user) u.username = encodeURIComponent(user);
        if (pass) u.password = encodeURIComponent(pass);
      }
      return u.toString();
    } catch {
      return `${base}/archives/file/${path}`;
    }
  };

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">archives</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            What went out, hour by hour.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Liquidsoap writes one MP3 per clock hour into <code>state/archive/</code>.
            They&rsquo;re kept until the operator deletes them — there is no automatic rotation,
            so keep an eye on disk if the station runs 24/7.
          </div>
        </div>
        <div className="flex items-center gap-4 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{entries.length} hour{entries.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">{fmtSize(totalBytes)} total</span>
        </div>
      </section>

      {byDate.length === 0 && (
        <Card title="No recordings yet">
          <div className="text-[12px] leading-[1.6] text-muted">
            The first hour writes once the clock crosses the next <code>HH:00</code>. If you started the
            station mid-hour, you&rsquo;ll see the first file after the next top of the hour.
          </div>
        </Card>
      )}

      {byDate.map(group => (
        <Card
          key={group.date}
          title={group.date}
          right={<Pill>{group.items.length} h · {fmtSize(group.bytes)}</Pill>}
        >
          <ul className="divide-y divide-[var(--ink-soft)]">
            {group.items.map(e => (
              <li key={e.path} className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <span className="mono-num text-[13px] font-bold">{hourLabel(e.hour)}</span>
                  <span className="text-[11px] text-muted">{fmtSize(e.bytes)}</span>
                  <span className="text-[10px] text-muted">{relTime(e.mtime)} ago</span>
                </div>
                <a href={downloadHref(e.path)} download>
                  <Btn sm tone="accent">Download</Btn>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
