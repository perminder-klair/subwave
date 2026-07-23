'use client';

// Playlists tab of /admin/library — the operator's Navidrome playlists,
// created/curated from the track tabs' selection flow. Backed by the
// controller's /playlists routes (thin Subsonic wrappers). Entries are removed
// by POSITION (Subsonic's updatePlaylist semantics), so every mutation
// refetches the entry list before the next removal can be issued.

import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { Card, Btn } from './ui';
import { cn } from '../../lib/cn';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';

export interface PlaylistSummary {
  id: string;
  name: string;
  songCount: number;
  durationSec: number;
  owner: string;
  public: boolean;
}

interface PlaylistEntry {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  durationSec?: number;
}

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Two-click destructive button: first click arms it, second fires. Re-disarms
// after a beat so a stray click never deletes anything.
function ConfirmBtn({ label, confirmLabel, busy, onConfirm }: {
  label: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Btn
      sm
      tone="danger"
      disabled={busy}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </Btn>
  );
}

export default function LibraryPlaylistsTab({
  playlists, loading, onRefresh, adminFetch,
}: {
  playlists: PlaylistSummary[] | null;
  loading: boolean;
  onRefresh: () => void;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [entries, setEntries] = useState<PlaylistEntry[] | null>(null);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // create-empty-playlist row (header "New playlist" button toggles it)
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // inline per-playlist editor — name + visibility
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPublic, setEditPublic] = useState(true);

  const loadEntries = useCallback(async (id: string) => {
    setEntriesLoading(true);
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(id)}`);
      const j = await r.json().catch(() => ({})) as { entries?: PlaylistEntry[]; error?: string };
      if (!r.ok) throw new Error(j.error || `playlist load failed (${r.status})`);
      setEntries(j.entries || []);
    } catch (err) {
      notify.err(errorMessage(err));
      setEntries([]);
    } finally {
      setEntriesLoading(false);
    }
  }, [adminFetch]);

  const toggleOpen = (id: string) => {
    if (openId === id) { setOpenId(null); setEntries(null); return; }
    setOpenId(id);
    setEntries(null);
    loadEntries(id);
  };

  const removeEntry = async (playlistId: string, index: number, title?: string) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indexes: [index] }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `remove failed (${r.status})`);
      notify.ok(`removed ${title ? `“${title}”` : 'track'}`);
      await loadEntries(playlistId);
      onRefresh();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createPlaylist = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await adminFetch('/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, songIds: [] }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `create failed (${r.status})`);
      notify.ok(`created “${name}” — select tracks in any tab to fill it`);
      setCreating(false);
      setNewName('');
      onRefresh();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (pl: PlaylistSummary) => {
    if (editId === pl.id) { setEditId(null); return; }
    setEditId(pl.id);
    setEditName(pl.name);
    setEditPublic(pl.public);
  };

  const saveEdit = async (pl: PlaylistSummary) => {
    const name = editName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(pl.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, public: editPublic }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `update failed (${r.status})`);
      notify.ok(`updated “${name}”`);
      setEditId(null);
      onRefresh();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const deletePlaylist = async (pl: PlaylistSummary) => {
    setBusy(true);
    try {
      const r = await adminFetch(`/playlists/${encodeURIComponent(pl.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error || `delete failed (${r.status})`);
      notify.ok(`deleted “${pl.name}”`);
      if (openId === pl.id) { setOpenId(null); setEntries(null); }
      onRefresh();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = playlists || [];

  return (
    <Card
      title="Playlists"
      sub={playlists ? `${rows.length} playlist${rows.length === 1 ? '' : 's'} in Navidrome` : ''}
      right={
        <span className="flex items-center gap-1.5">
          <Btn sm tone="accent" onClick={() => setCreating(c => !c)} disabled={busy}>
            <Plus size={11} /> New playlist
          </Btn>
          <Btn sm onClick={onRefresh} disabled={loading}>
            <RefreshCw size={11} /> {loading ? 'Loading…' : 'Refresh'}
          </Btn>
        </span>
      }
      bodyClass="!p-0"
    >
      {creating && (
        <div className="flex flex-wrap items-center gap-2 border-b border-dashed border-separator-strong bg-[var(--ink-softer)] px-4 py-3">
          <Input
            placeholder="playlist name"
            className="w-56"
            value={newName}
            autoFocus
            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createPlaylist(); }}
          />
          <Btn sm tone="accent" onClick={createPlaylist} disabled={busy || !newName.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </Btn>
          <Btn sm onClick={() => { setCreating(false); setNewName(''); }} disabled={busy}>Cancel</Btn>
        </div>
      )}
      {loading && rows.length === 0 && <SkeletonRows rows={4} />}
      {!loading && rows.length === 0 && (
        <EmptyState
          compact
          title="No playlists yet"
          description={<>Select tracks in any tab and “Add to playlist” to start one.</>}
        />
      )}
      {rows.map(pl => {
        const open = openId === pl.id;
        return (
          <div key={pl.id} className="border-b border-dashed border-separator-strong last:border-b-0">
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => toggleOpen(pl.id)}
                aria-expanded={open}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="lib-title">{pl.name}</span>
                <span className="text-[11px] whitespace-nowrap text-muted">
                  {pl.songCount} track{pl.songCount === 1 ? '' : 's'}
                  {pl.durationSec ? ` · ${fmtDuration(pl.durationSec)}` : ''}
                  {pl.owner ? ` · ${pl.owner}` : ''}
                  {!pl.public ? ' · private' : ''}
                </span>
              </button>
              <Btn
                sm
                tone={editId === pl.id ? 'accent' : undefined}
                onClick={() => startEdit(pl)}
                disabled={busy}
                title="Rename / visibility"
              >
                {editId === pl.id ? <X size={11} /> : <Pencil size={11} />}
              </Btn>
              <ConfirmBtn
                label={<><Trash2 size={11} /> Delete</>}
                confirmLabel="Really delete?"
                busy={busy}
                onConfirm={() => deletePlaylist(pl)}
              />
            </div>
            {editId === pl.id && (
              <div className="flex flex-wrap items-center gap-3 border-t border-dashed border-separator-strong bg-[var(--ink-softer)] px-4 py-3">
                <Input
                  className="w-56"
                  value={editName}
                  autoFocus
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveEdit(pl); }}
                />
                <label className="flex items-center gap-2 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    checked={editPublic}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setEditPublic(e.target.checked)}
                    disabled={busy}
                  />
                  public — visible to other Navidrome users
                </label>
                <Btn sm tone="accent" onClick={() => saveEdit(pl)} disabled={busy || !editName.trim()}>
                  {busy ? 'Saving…' : 'Save'}
                </Btn>
                <Btn sm onClick={() => setEditId(null)} disabled={busy}>Cancel</Btn>
              </div>
            )}
            {open && (
              <div className="border-t border-dashed border-separator-strong bg-[var(--ink-softer)]">
                {entriesLoading && <SkeletonRows rows={4} />}
                {!entriesLoading && entries && entries.length === 0 && (
                  <div className="px-4 py-4 text-center text-[12px] text-muted italic">empty playlist</div>
                )}
                {!entriesLoading && entries?.map((e, i) => (
                  <div
                    key={`${e.id}-${i}`}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2',
                      i > 0 && 'border-t border-dashed border-separator-strong',
                    )}
                  >
                    <span className="mono-num w-6 text-right text-[10px] text-muted">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="lib-title">{e.title || '—'}</div>
                      <div className="lib-artist">{e.artist || '—'}{e.album ? ` · ${e.album}` : ''}</div>
                    </div>
                    <Btn sm disabled={busy} onClick={() => removeEntry(pl.id, i, e.title)} title="Remove from playlist">
                      <X size={12} />
                    </Btn>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}
