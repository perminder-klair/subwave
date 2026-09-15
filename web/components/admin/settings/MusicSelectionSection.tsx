'use client';

import type { ChangeEvent } from 'react';
import { Label } from '../../ui/label';
import { Input } from '../../ui/input';
import { Card, Seg } from '../ui';
import { SectionHeader, SaveBar, type SectionProps } from './shared';
import { PICKER_MIN_TRACK_LENGTH_BOUNDS } from '@/lib/schemas.generated';

export function MusicSelectionSection({ data, form, setForm, busy, saveSettings, fieldErrors }: SectionProps) {
  const save = async () => {
    await saveSettings({
      llm: {
        trackSelection: form.llm.trackSelection,
        shortlistPasses: form.llm.shortlistPasses,
        requestMatching: form.llm.requestMatching,
        noRepeatWindow: Math.max(0, parseInt(form.llm.noRepeatWindow, 10) || 0),
        artistVarietyWindow: Math.max(0, parseInt(form.llm.artistVarietyWindow, 10) || 0),
        discoverySteps: form.llm.discoverySteps,
        agentTimeoutMs: form.llm.agentTimeoutMs,
        pickerAgent: form.llm.trackSelection === 'agentic',
      },
      picker: {
        albumHours: Number(form.picker.albumHours),
        minTrackLengthSeconds: Number(form.picker.minTrackLengthSeconds),
      },
    });
  };

  return (
    <>
      <SectionHeader
        eyebrow="music selection"
        title="Decide how the DJ finds music."
        sub="Both routes follow the same station and show rules; they differ only in where library exploration happens."
      />

      <Card title="Music selection" sub={form.llm.trackSelection === 'agentic' ? 'Agentic Tools' : 'Track Shortlist'}>
        <div className="field">
          <Label>How the DJ finds its next track</Label>
          <Seg
            value={form.llm.trackSelection}
            options={[
              { id: 'agentic', label: 'Agentic Tools', title: 'The LLM explores the library and chooses the track' },
              { id: 'shortlist', label: 'Track Shortlist', title: 'The controller explores the library, then the LLM chooses from eligible tracks' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, trackSelection: v as 'agentic' | 'shortlist' } }))}
          />
          <p className="mt-2 text-[13px] leading-[1.55] text-muted">
            Both routes use the same library exploration tools and apply the same show rules, recency protections,
            requests and Musical Leanings. With <strong>Agentic Tools</strong>, the LLM uses those tools to explore
            the library and makes the final pick. With <strong>Track Shortlist</strong>, the controller explores with
            those same tools first, builds an eligible shortlist, then asks the LLM to choose from it.
          </p>
        </div>
        {form.llm.trackSelection === 'agentic' ? (
          <>
            <div className="field mt-5">
              <Label>Agent deadline (seconds)</Label>
              <Input type="number" min={5} max={300} step={5} value={Math.round(form.llm.agentTimeoutMs / 1000)}
                onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, agentTimeoutMs: Number(e.target.value) * 1000 } }))} className="max-w-[200px]" />
              <p className="mt-2 text-[13px] leading-[1.55] text-muted">How long an Agentic pick may run before the station uses its safe fallback. 5–300 seconds.</p>
            </div>
            <div className="field mt-5">
              <Label>Discovery rounds per pick</Label>
              <Input type="number" min={0} max={5} step={1} value={form.llm.discoverySteps}
                onChange={e => setForm(f => ({ ...f, llm: { ...f.llm, discoverySteps: Number(e.target.value) } }))} className="max-w-[200px]" />
              <p className="mt-2 text-[13px] leading-[1.55] text-muted">How many library searches the agent may make before choosing. Zero follows the provider default.</p>
            </div>
          </>
        ) : (
          <div className="field mt-5">
            <Label>Track Shortlist passes</Label>
            <Seg value={String(form.llm.shortlistPasses)} options={[
              { id: '1', label: '1', title: 'Context only — the narrowest shortlist' },
              { id: '2', label: '2', title: 'Context and Continuity — no Exploration pass' },
              { id: '3', label: '3', title: 'Default: Context, Continuity, then Exploration' },
              { id: '4', label: '4', title: 'Repeats Context after the complete three-lane cycle' },
              { id: '5', label: '5', title: 'Repeats Context and Continuity for the broadest shortlist' },
            ]} onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, shortlistPasses: Number(v) } }))} />
            <p className="mt-2 text-[13px] leading-[1.55] text-muted">
              Three passes are the default: <strong>Context</strong> grounds the show or journey, <strong>Continuity</strong> follows the track on air, and <strong>Exploration</strong> reaches beyond the familiar. Two passes omit Exploration; one uses Context only, for a deliberately narrow shortlist. Four and five repeat Context then Continuity, widening the candidate set and final DJ selection prompt. This does not change Agentic Segment tools.
            </p>
          </div>
        )}
      </Card>

      <Card title="Request matching" sub={form.llm.requestMatching === 'agentic' ? 'Agent-assisted' : 'Direct'}>
        <div className="field">
          <Label>How listener requests are matched</Label>
          <Seg value={form.llm.requestMatching} options={[
            { id: 'direct', label: 'Direct matching', title: 'Fast, tool-free matching for straightforward requests' },
            { id: 'agentic', label: 'Agent-assisted', title: 'Uses music-search tools for detailed or compound requests' },
          ]} onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, requestMatching: v as 'agentic' | 'direct' } }))} />
          <p className="mt-2 text-[13px] leading-[1.55] text-muted">Direct matching covers the majority of artist, title, genre and simple-mood requests. Agent-assisted matching can interpret more detailed or compound requests, but needs a tool-capable model and may take longer or use more LLM resources.</p>
        </div>
      </Card>

      <Card title="Selection policy" sub="shared rules">
        <div className="field mt-4"><Label>No-repeat window (tracks)</Label><Input type="number" min={0} max={1000} step={10} value={form.llm.noRepeatWindow} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, llm: { ...f.llm, noRepeatWindow: e.target.value } }))} placeholder="250" className="max-w-[200px]" /><div className="field-hint">The last N <strong>distinct</strong> tracks can never be re-picked: a hard guard on both selection paths, on top of the time-based window. It scales down on a small library so it never blocks everything. <strong>0 = off</strong>. Listener requests stay exempt. 0&ndash;1000.</div></div>
        <div className="field mt-4"><Label>Artist spacing (slots)</Label><Input type="number" min={0} max={25} step={1} value={form.llm.artistVarietyWindow} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, llm: { ...f.llm, artistVarietyWindow: e.target.value } }))} placeholder="5" className="max-w-[200px]" /><div className="field-hint">How many slots the DJ waits before returning to an artist. A pick inside the window is re-taken from the run&apos;s other eligible tracks, and quietly stands only if nothing fresher turned up. <strong>0 = off</strong>, though an artist can never follow itself. 0&ndash;25.</div></div>
        <div className="field mt-4"><Label>Album cooldown (hours)</Label><Input type="number" min={0} max={72} step={0.5} value={form.picker.albumHours} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, picker: { ...f.picker, albumHours: e.target.value } }))} placeholder="0" className="max-w-[200px]" /><div className="field-hint">How long a <strong>record</strong> rests after one of its tracks airs. It yields rather than starving selection, and compilations and various-artists albums are exempt. <strong>0 = off</strong> (the default). 0&ndash;72.</div></div>
        <div className="field mt-4"><Label>Minimum track length (seconds)</Label><Input type="number" min={0} max={PICKER_MIN_TRACK_LENGTH_BOUNDS.max} step={1} value={form.picker.minTrackLengthSeconds} onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, picker: { ...f.picker, minTrackLengthSeconds: e.target.value } }))} placeholder="0" className="max-w-[200px]" /><div className="field-hint">The shortest a track can be to get picked, on both selection paths and the offline fallback playlist. A show can set its own; listener requests are always exempt. <strong>0 = off</strong> (the default). A non-zero value must be at least {data?.values?.minTrackSeconds ?? 30}s.</div></div>
      </Card>

      <SaveBar note="Music selection applies from the next pick · no mixer restart." busy={busy} onSave={save} saveLabel="Save music selection" errors={fieldErrors}
        ownedKeys={['llm.trackSelection', 'llm.shortlistPasses', 'llm.requestMatching', 'llm.noRepeatWindow', 'llm.artistVarietyWindow', 'llm.discoverySteps', 'llm.agentTimeoutMs', 'picker']} />
    </>
  );
}
