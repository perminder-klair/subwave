'use client';

// The heart button's settings, as parts of the Listeners tab (ListenersSection):
// a main card, an Advanced card, the header metrics and the save payload.

import type { ChangeEvent } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Pill, Seg } from '../ui';
import type { SectionProps, LikesForm, SettingsData } from './shared';

type LikesPartProps = Pick<SectionProps, 'data' | 'form' | 'setForm'>;

function useLikes({ data, form, setForm }: LikesPartProps) {
  const lk = form.likes;
  const saved = data.values?.likes || {};
  const set = (patch: Partial<LikesForm>) =>
    setForm(f => ({ ...f, likes: { ...f.likes, ...patch } }));
  return { lk, saved, set };
}

export function likesMetrics(data: SettingsData) {
  const saved = data.values?.likes || {};
  return [
    { n: saved.enabled === false ? 'off' : 'on', l: 'heart button', accent: saved.enabled !== false },
    { n: saved.influenceDj ? 'on' : 'off', l: 'dj influence', accent: !!saved.influenceDj },
  ];
}

export function likesSavePayload(lk: LikesForm) {
  const maxTracks = parseInt(lk.maxTracks, 10);
  const windowDays = parseInt(lk.windowDays, 10);
  return {
    likes: {
      enabled: lk.enabled,
      starInNavidrome: lk.starInNavidrome,
      influenceDj: lk.influenceDj,
      ...(Number.isFinite(maxTracks) ? { maxTracks } : {}),
      ...(Number.isFinite(windowDays) ? { windowDays } : {}),
    },
  };
}

export function LikesHeartCard(props: LikesPartProps) {
  const { lk, saved, set } = useLikes(props);
  return (
    <Card title="Heart button" sub="the listener-facing control on every player skin">
      <div className="grid gap-[18px]">
        <div className="field">
          <div className="flex items-center gap-2">
            <Label>Enabled</Label>
            {lk.enabled !== (saved.enabled ?? true) && <Pill tone="accent" dot>unsaved</Pill>}
          </div>
          <Seg
            value={lk.enabled ? 'on' : 'off'}
            onChange={v => set({ enabled: v === 'on' })}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
          />
          <div className="field-hint">
            Off hides the heart on every skin and refuses <code>POST /like</code>.
            Existing like data is kept.
          </div>
        </div>

        <div className="field">
          <div className="flex items-center gap-2">
            <Label>Star in Navidrome</Label>
            {lk.starInNavidrome !== (saved.starInNavidrome ?? true) && <Pill tone="accent" dot>unsaved</Pill>}
          </div>
          <Seg
            value={lk.starInNavidrome ? 'on' : 'off'}
            onChange={v => set({ starInNavidrome: v === 'on' })}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
          />
          <div className="field-hint">
            When on, every liked track is starred in Navidrome via the Subsonic
            API: one shared &quot;station favourites&quot; list any Subsonic client can
            see and build playlists from. Clearing likes never unstars;
            Navidrome stays the source of truth for its own stars. The one
            exception is un-hearting your own like in the library when no
            other likes remain — that toggles the star back off.
          </div>
        </div>
      </div>
    </Card>
  );
}

export function LikesInfluenceCard(props: LikesPartProps) {
  const { lk, saved, set } = useLikes(props);
  return (
    <Card title="AI DJ influence" sub="feed listener taste back into track selection">
      <div className="grid gap-[18px]">
        <div className="field">
          <div className="flex items-center gap-2">
            <Label>Use likes to influence picks</Label>
            {lk.influenceDj !== !!saved.influenceDj && <Pill tone="accent" dot>unsaved</Pill>}
          </div>
          <Seg
            value={lk.influenceDj ? 'on' : 'off'}
            onChange={v => set({ influenceDj: v === 'on' })}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
          />
          <div className="field-hint">
            When on, the most-liked tracks ride into both pick paths (the
            session DJ&apos;s prompt and the pool picker&apos;s candidate list) as a
            weighted preference signal (favour these and similar artists,
            genres, moods), never a hard playlist. Variety rules still apply.
          </div>
        </div>

        <div className="field">
          <Label>Tracks included</Label>
          <Input
            type="number"
            min={1}
            max={25}
            value={lk.maxTracks}
            onChange={(e: ChangeEvent<HTMLInputElement>) => set({ maxTracks: e.target.value })}
            className="max-w-[120px]"
          />
          <div className="field-hint">How many top-liked tracks the DJ sees (1–25).</div>
        </div>

        <div className="field">
          <Label>Time window (days)</Label>
          <Input
            type="number"
            min={0}
            max={365}
            value={lk.windowDays}
            onChange={(e: ChangeEvent<HTMLInputElement>) => set({ windowDays: e.target.value })}
            className="max-w-[120px]"
          />
          <div className="field-hint">
            Count likes from the last N days. <code>0</code> = all time.
          </div>
        </div>
      </div>
    </Card>
  );
}
