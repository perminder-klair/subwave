'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useState } from 'react';
import { ListMusic } from 'lucide-react';
import { Input } from '../../ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../ui/select';
import { Card, Btn } from '../ui';
 
import type { PlaylistSummary } from './types';

// The shared selection bar, on every Library tab with ticked rows. `download`:
// the Library download of the ticked rows (DownloadButton.tsx SelectionDownload),
// beside the bar's own buttons.
export function AddToPlaylistBar({ count, playlists, busy, onAdd, onClear, download }: {
  count: number;
  playlists: PlaylistSummary[] | null;
  busy: boolean;
  onAdd: (target: { playlistId?: string; name?: string }) => void;
  onClear: () => void;
  download?: ReactNode;
}) {
  const [target, setTarget] = useState<string>('__new');
  const [name, setName] = useState('');
  const creating = target === '__new';
  const canAdd = creating ? !!name.trim() : true;

  return (
    <Card bodyClass="!py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-bold text-ink">
          {count} track{count === 1 ? '' : 's'} selected
        </span>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger className="max-w-full min-w-[180px]" aria-label="Target playlist"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__new">New playlist…</SelectItem>
            {(playlists || []).map(p => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} · {p.songCount}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {creating && (
          <Input
            placeholder="playlist name"
            aria-label="New playlist name"
            className="w-48 max-w-full"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          />
        )}
        <Btn
          sm
          tone="accent"
          disabled={busy || !canAdd}
          onClick={() => onAdd(creating ? { name: name.trim() } : { playlistId: target })}
        >
          <ListMusic size={12} /> {busy ? 'Adding…' : creating ? 'Create playlist' : 'Add to playlist'}
        </Btn>
        {download}
        <Btn sm onClick={onClear} disabled={busy}>Clear selection</Btn>
      </div>
    </Card>
  );
}

