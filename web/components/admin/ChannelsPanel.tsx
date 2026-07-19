'use client';

// Channels — /admin/channels. Sub-stations: parallel always-on streams that
// share this install's library. Each channel pins a show as its music
// identity (null = the station's default mood-driven pool), airs on
// /ch/<id>/stream.mp3 via its own liquidsoap process (the broadcast
// supervisor starts/stops them from state/channels.json within ~15s of a
// save), and — with a persona — gets its own DJ picks and idents, gated by
// the channel's talk frequency (quiet by default).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Card, Btn, Eyebrow, Pill } from './ui';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';

interface ChannelRow {
  id: string;
  name: string;
  enabled: boolean;
  showId: string | null;
  telnetPort?: number;
  frequency: string;
  personaId: string;
  jingleRatio: number | null;
  crossfadeDuration: number | null;
}

interface SettingsResponse {
  values?: {
    channels?: ChannelRow[];
    shows?: { id: string; name: string }[];
    personas?: { id: string; name: string }[];
  };
  tts?: { frequencies?: string[] };
}

const CHANNELS_LIMIT = 8;

// Radix Select items can't carry an empty-string value — sentinel for the
// "inherit the station default" rows.
const NONE = '__none__';

// Mirror the controller's channel-id rule (settings.ts CHANNEL_ID_RE).
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

export default function ChannelsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [shows, setShows] = useState<{ id: string; name: string }[]>([]);
  const [personas, setPersonas] = useState<{ id: string; name: string }[]>([]);
  const [frequencies, setFrequencies] = useState<string[]>(['silent', 'quiet', 'moderate', 'chatty', 'aggressive']);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      const j = (await r.json()) as SettingsResponse;
      setChannels(Array.isArray(j.values?.channels) ? j.values.channels : []);
      setShows(Array.isArray(j.values?.shows) ? j.values.shows : []);
      setPersonas(Array.isArray(j.values?.personas) ? j.values.personas : []);
      if (Array.isArray(j.tts?.frequencies) && j.tts.frequencies.length) {
        setFrequencies(j.tts.frequencies);
      }
      setErr(null);
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
  }, [hydrated, needsAuth, load]);

  const mutate = (idx: number, patch: Partial<ChannelRow>) => {
    setChannels(cur => (cur ? cur.map((c, i) => (i === idx ? { ...c, ...patch } : c)) : cur));
    setDirty(true);
    setNotice(null);
  };

  const addChannel = () => {
    const name = newName.trim();
    if (!name || !channels) return;
    const id = slugify(name);
    if (!id) {
      setErr('Channel name must contain at least one letter or digit.');
      return;
    }
    if (channels.some(c => c.id === id)) {
      setErr(`A channel with the id "${id}" already exists.`);
      return;
    }
    setChannels([
      ...channels,
      { id, name, enabled: true, showId: null, frequency: 'quiet', personaId: '', jingleRatio: null, crossfadeDuration: null },
    ]);
    setNewName('');
    setErr(null);
    setDirty(true);
  };

  const save = async () => {
    if (!channels) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setNotice('Saved — the broadcast supervisor applies channel changes within ~15 seconds.');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const atLimit = useMemo(() => (channels?.length ?? 0) >= CHANNELS_LIMIT, [channels]);

  if (!hydrated || needsAuth) return null;

  return (
    <div className="grid gap-4">
      <Card
        title="Channels"
        sub="Parallel always-on streams sharing this station's library. Each channel pins a show as its format and airs at /ch/<id> with its own DJ."
      >
        {err && <p className="caption m-0 mb-2 text-vermilion">{err}</p>}
        {notice && <p className="caption m-0 mb-2 text-muted">{notice}</p>}

        {channels === null ? (
          <p className="caption m-0 text-muted">Loading…</p>
        ) : channels.length === 0 ? (
          <p className="caption m-0 text-muted">
            No channels yet. Add one below — the family gets a second station without a second install.
          </p>
        ) : (
          <div className="grid gap-3">
            {channels.map((c, i) => (
              <div key={c.id} className="grid gap-2 border border-soft-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Eyebrow>/ch/{c.id}</Eyebrow>
                  <Pill tone={c.enabled ? 'accent' : 'default'}>{c.enabled ? 'on air' : 'off'}</Pill>
                  <a
                    className="caption text-muted underline"
                    href={`/ch/${encodeURIComponent(c.id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open player ↗
                  </a>
                  <span className="flex-1" />
                  <Btn sm onClick={() => mutate(i, { enabled: !c.enabled })}>
                    {c.enabled ? 'Disable' : 'Enable'}
                  </Btn>
                  <Btn
                    sm
                    tone="danger"
                    onClick={() => {
                      setChannels(cur => (cur ? cur.filter((_, j) => j !== i) : cur));
                      setDirty(true);
                    }}
                  >
                    Remove
                  </Btn>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="field">
                    <Label>Name (on-air station name)</Label>
                    <Input
                      value={c.name}
                      maxLength={80}
                      onChange={e => mutate(i, { name: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <Label>Format (pinned show)</Label>
                    <Select
                      value={c.showId ?? NONE}
                      onValueChange={v => mutate(i, { showId: v === NONE ? null : v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>— station default pool —</SelectItem>
                        {shows.map(sh => (
                          <SelectItem key={sh.id} value={sh.id}>{sh.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="field">
                    <Label>DJ persona</Label>
                    <Select
                      value={c.personaId || NONE}
                      onValueChange={v => mutate(i, { personaId: v === NONE ? '' : v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>— station persona —</SelectItem>
                        {personas.map(p => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="field">
                    <Label>Talk frequency</Label>
                    <Select
                      value={c.frequency}
                      onValueChange={v => mutate(i, { frequency: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {frequencies.map(f => (
                          <SelectItem key={f} value={f}>{f}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="field">
            <Label>New channel name</Label>
            <Input
              placeholder="e.g. Muppets Radio"
              value={newName}
              maxLength={80}
              disabled={atLimit}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addChannel(); }}
            />
          </div>
          <Btn onClick={addChannel} disabled={atLimit || !newName.trim()}>Add channel</Btn>
          <span className="flex-1" />
          <Btn tone="accent" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save channels'}
          </Btn>
        </div>
        {atLimit && (
          <p className="caption m-0 mt-2 text-muted">Channel limit reached ({CHANNELS_LIMIT}).</p>
        )}
      </Card>
    </div>
  );
}
