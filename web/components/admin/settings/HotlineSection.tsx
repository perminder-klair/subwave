'use client';

// The station-wide Hotline settings (docs/plans/hotline.md). The line itself is
// opened show by show in the show editor; these say which voice answers and how
// long a Call may run once it is open. The OpenAI key lives with the other
// cloud keys (LLM → keys), and the dashboard's Hotline card says whether it is
// set and shows the Call on the line.
import type { ChangeEvent } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Pill } from '../ui';
import type { FormState, FormUpdater, HotlineForm } from './shared';

// OpenAI Realtime's voices. '' = match the on-air persona when it already uses
// one of these on OpenAI TTS, otherwise marin.
const VOICES = ['', 'marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;

export function hotlineSavePayload(h: HotlineForm) {
  return {
    provider: 'openai',
    model: h.model.trim() || 'gpt-realtime',
    voice: h.voice,
    maxCallSec: parseInt(h.maxCallSec, 10),
    wrapUpSec: parseInt(h.wrapUpSec, 10),
    dailyMinutes: parseInt(h.dailyMinutes, 10),
    callsPerDevicePerShow: parseInt(h.callsPerDevicePerShow, 10),
  };
}

function NumberField({ label, value, min, max, onChange, hint }: {
  label: string; value: string; min: number; max: number; onChange: (v: string) => void; hint: string;
}) {
  return (
    <div className="field">
      <Label>{label}</Label>
      <Input
        className="mono-num w-28"
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
      <div className="field-hint">{hint}</div>
    </div>
  );
}

export function HotlineCard({ form, setForm }: {
  form: FormState;
  setForm: FormUpdater;
}) {
  const h = form.hotline;
  const set = (patch: Partial<HotlineForm>) => setForm(f => ({ ...f, hotline: { ...f.hotline, ...patch } }));
  return (
    <Card
      title="Hotline"
      anchor="hotline"
      sub="Listeners ring the DJ from the player: a private voice call where the DJ can queue one track and a dedication"
    >
      <div className="grid gap-3">
        <div className="field-hint">
          Off until a show turns it on (Shows → a show → Hotline), and only while an OpenAI key is
          set. Calls are never broadcast and nothing is recorded: the DJ queues at most one track
          per call through the normal request rules, and introduces any dedication on air in its
          own words. Every minute is billed to your OpenAI key, so the daily cap below is the
          most a day can cost.
        </div>

        <div className="field">
          <Label>Voice</Label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Hotline voice">
            {VOICES.map(v => (
              <Pill key={v || 'auto'} pressed={h.voice === v} onClick={() => set({ voice: v })}>
                {v || 'match persona'}
              </Pill>
            ))}
          </div>
          <div className="field-hint">
            &ldquo;Match persona&rdquo; keeps the on-air voice when the host already speaks with one
            of these on OpenAI TTS, and uses marin otherwise. The player adds a light phone-line
            filter, so a different voice still reads as the DJ on the phone.
          </div>
        </div>

        <NumberField
          label="Longest call (seconds)"
          value={h.maxCallSec}
          min={60}
          max={900}
          onChange={v => set({ maxCallSec: v })}
          hint="The line is cut here whatever is happening. Clamped 60–900."
        />
        <NumberField
          label="Wrap up at (seconds)"
          value={h.wrapUpSec}
          min={30}
          max={870}
          onChange={v => set({ wrapUpSec: v })}
          hint="When the DJ is told to say goodbye. Always lands at least 30 s before the cut."
        />
        <NumberField
          label="Minutes per day"
          value={h.dailyMinutes}
          min={1}
          max={1440}
          onChange={v => set({ dailyMinutes: v })}
          hint="All calls together, per station day. Past it the Hotline reads closed until tomorrow."
        />
        <NumberField
          label="Calls per listener per show"
          value={h.callsPerDevicePerShow}
          min={1}
          max={10}
          onChange={v => set({ callsPerDevicePerShow: v })}
          hint="Counted per device for each airing of a show."
        />

        <div className="field">
          <Label>Model</Label>
          <Input
            className="mono-num w-56"
            aria-label="Hotline model"
            value={h.model}
            onChange={(e: ChangeEvent<HTMLInputElement>) => set({ model: e.target.value })}
          />
          <div className="field-hint">The OpenAI Realtime model that answers. gpt-realtime unless you know you want another.</div>
        </div>
      </div>
    </Card>
  );
}
