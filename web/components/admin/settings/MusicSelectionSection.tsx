'use client';

import type { ChangeEvent } from 'react';
import { Label } from '../../ui/label';
import { Input } from '../../ui/input';
import { Card, Pill, Seg } from '../ui';
import { Advanced } from './section-chrome';
import { SectionHeader, SaveBar, NowBanner, type SectionProps } from './shared';
import { sectionById } from './registry';
import { PICKER_MIN_TRACK_LENGTH_BOUNDS, SHORTLIST_PASSES_BOUNDS, settingsAgentRoutes } from '@/lib/schemas.generated';

const PASS_TITLES: Record<number, string> = {
  1: 'Quickest, narrowest search',
  2: 'Adds another suitable discovery source',
  3: 'Recommended balance of fit and variety',
  4: 'Searches one more source for a wider choice',
  5: 'Widest search, with more candidates to compare',
};

const ROUTE_LABEL = { agentic: 'Agentic Tools', shortlist: 'Track Shortlist' } as const;

/**
 * What plays next: the selection route, how requests are matched, and the
 * repeat rules both routes share. What the DJ SAYS lives in DJ behaviour.
 */
export function MusicSelectionSection({ data, form, setForm, busy, saveSettings, fieldErrors }: SectionProps) {
  const savedLlm = data.values?.llm || {};
  const savedRoute = savedLlm.trackSelection === 'shortlist' ? 'shortlist' : 'agentic';
  const routeDirty = form.llm.trackSelection !== savedRoute
    || (form.llm.trackSelection === 'shortlist' && form.llm.shortlistPasses !== savedLlm.shortlistPasses)
    || (form.llm.trackSelection === 'agentic' && form.llm.discoverySteps !== savedLlm.discoverySteps);
  // The deadline governs every agent run, not only Agentic Tools picks: a
  // Shortlist station with agent-assisted requests or agentic segments still
  // needs to see and set it.
  const agentRoutes = settingsAgentRoutes(form.llm);
  const passes = Array.from(
    { length: SHORTLIST_PASSES_BOUNDS.max - SHORTLIST_PASSES_BOUNDS.min + 1 },
    (_, i) => SHORTLIST_PASSES_BOUNDS.min + i,
  );

  const save = async () => {
    await saveSettings({
      llm: {
        trackSelection: form.llm.trackSelection,
        shortlistPasses: form.llm.shortlistPasses,
        guestMusicalLeanings: form.llm.guestMusicalLeanings,
        requestMatching: form.llm.requestMatching,
        requestWebResolve: form.llm.requestWebResolve,
        noRepeatWindow: Math.max(0, parseInt(form.llm.noRepeatWindow, 10) || 0),
        artistVarietyWindow: Math.max(0, parseInt(form.llm.artistVarietyWindow, 10) || 0),
        discoverySteps: form.llm.discoverySteps,
        agentTimeoutMs: form.llm.agentTimeoutMs,
      },
      // Its own top-level key, not part of `llm`: the album cooldown and the
      // length floor are read by the pool picker too, so they are picking
      // config rather than LLM config. Blank or junk input saves as 0 (off),
      // as it did before this card moved here.
      picker: {
        albumHours: Math.max(0, parseFloat(form.picker.albumHours) || 0),
        minTrackLengthSeconds: Math.max(0, parseInt(form.picker.minTrackLengthSeconds, 10) || 0),
      },
    });
  };

  return (
    <>
      <SectionHeader
        eyebrow="music selection"
        title="How the DJ finds the next track."
        sub="Both routes follow the same show rules, repeat protection and Musical Leanings; they differ only in where the library is explored. Changes apply from the next pick, no mixer restart."
        metrics={[{ n: ROUTE_LABEL[savedRoute], l: 'selection route' }]}
        manualHref="/manual/concepts"
        manualLabel="Shortlist vs Agentic, explained"
      />

      <Card title="Track selection" sub="how the next track is chosen">
        <div className="grid gap-[18px]">
          <NowBanner label={<>Selecting now · {ROUTE_LABEL[savedRoute]}</>}>
            {savedRoute === 'shortlist'
              ? <>The controller gathers a shortlist in {savedLlm.shortlistPasses ?? SHORTLIST_PASSES_BOUNDS.min} {savedLlm.shortlistPasses === 1 ? 'pass' : 'passes'}, then the model makes one choice per pick.</>
              : <>The model explores the library with its own tools, then commits to a track.</>}
            {' '}{routeDirty ? 'Your edits below aren’t live until you Save.' : 'This is the saved, running config.'}
          </NowBanner>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Route</Label>
              {routeDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <Seg
              accent
              value={form.llm.trackSelection}
              options={[
                { id: 'agentic', label: 'Agentic Tools', title: 'The LLM explores the library and chooses the track' },
                { id: 'shortlist', label: 'Track Shortlist', title: 'The controller explores the library, then the LLM chooses from eligible tracks' },
              ]}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, trackSelection: v as 'agentic' | 'shortlist' } }))}
            />
            <div className="field-hint">
              <strong>Agentic Tools</strong> suits a capable model with reliable tool calling that should
              explore the library itself. <strong>Track Shortlist</strong> suits smaller or local models, or
              faster and more predictable picks: SUB/WAVE gathers suitable tracks first and the model makes
              the final choice.
            </div>
          </div>

          {form.llm.trackSelection === 'shortlist' ? (
            <div className="field">
              <Label>Shortlist passes</Label>
              <Seg
                value={String(form.llm.shortlistPasses)}
                options={passes.map(n => ({ id: String(n), label: String(n), title: PASS_TITLES[n] }))}
                onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, shortlistPasses: Number(v) } }))}
              />
              <div className="field-hint">
                Each pass gathers candidates from one suitable part of your library, balancing the
                show&apos;s mood and genre, continuity with the current track, and wider discovery; strict
                playlists and sonic journeys stay on their own direction. <strong>3 is a good start.</strong>{' '}
                More passes widen the shortlist without adding LLM calls. {SHORTLIST_PASSES_BOUNDS.min}&ndash;{SHORTLIST_PASSES_BOUNDS.max}.
              </div>
            </div>
          ) : (
            <div className="field">
              <Label>Discovery rounds per pick</Label>
              <Input
                type="number" min={0} max={5} step={1}
                value={form.llm.discoverySteps}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, llm: { ...f.llm, discoverySteps: Number(e.target.value) } }))}
                placeholder="0"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                How many library searches the agent may make before it commits.{' '}
                <strong>0 = auto</strong>: 1 for self-hosted servers, 3 for cloud providers. Every round is a
                separate call sharing the agent deadline. 0&ndash;5.
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="Request matching" sub="how listener requests reach the library">
        <div className="grid gap-[18px]">
          <div className="field">
            <Label>Matching</Label>
            <Seg
              value={form.llm.requestMatching}
              options={[
                { id: 'direct', label: 'Direct', title: 'Fast, tool-free matching for straightforward requests' },
                { id: 'agentic', label: 'Agent-assisted', title: 'Uses music-search tools for detailed or compound requests' },
              ]}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, requestMatching: v as 'agentic' | 'direct' } }))}
            />
            <div className="field-hint">
              Direct matching covers most artist, title, genre and simple-mood requests in one call.
              Agent-assisted matching can untangle detailed or compound requests, but needs a
              tool-capable model and takes longer.
            </div>
          </div>
          {form.llm.requestMatching === 'agentic' && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
              <div>
                <div className="text-[13px] font-bold">Resolve described requests via web</div>
                <div className="field-hint mt-1 max-w-[440px]">
                  A listener who <em>describes</em> a track (&ldquo;the song from the new Dune
                  movie&rdquo;) gets it looked up on the web, then matched to your library. Needs a
                  web-search provider under Web search; otherwise it does nothing.
                </div>
              </div>
              <Seg
                accent
                value={form.llm.requestWebResolve ? 'on' : 'off'}
                options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
                onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, requestWebResolve: v === 'on' } }))}
              />
            </div>
          )}
        </div>
      </Card>

      <Advanced note="the agent deadline, repeat rules, track floor and guest leanings">
        {agentRoutes.any && (
          <Card title="Agent deadline" sub="how long one agent run may take">
            <div className="field">
              <Label>Deadline (seconds)</Label>
              <Input
                type="number" min={5} max={300} step={5}
                value={Math.round(form.llm.agentTimeoutMs / 1000)}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, llm: { ...f.llm, agentTimeoutMs: Number(e.target.value) * 1000 } }))}
                placeholder="45"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                How long one agent run may take before the station uses its safe fallback. It covers every
                route set to use an agent:{' '}
                {[
                  agentRoutes.picks && 'Agentic Tools picks',
                  agentRoutes.requests && 'agent-assisted request matching',
                  agentRoutes.segments && 'agentic Segments & Skills',
                ].filter(Boolean).join(', ')}. Slow reasoning models often need 20&ndash;40s; lower it for
                snappier fallbacks on a fast model. 5&ndash;300.
              </div>
            </div>
          </Card>
        )}

        <Card title="Repeat & variety" sub="shared by both routes">
          <div className="grid gap-[18px]">
            <div className="field">
              <Label>No-repeat window (tracks)</Label>
              <Input
                type="number" min={0} max={1000} step={10}
                value={form.llm.noRepeatWindow}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, llm: { ...f.llm, noRepeatWindow: e.target.value } }))}
                placeholder="250"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                The last N <strong>distinct</strong> tracks can never be re-picked: a hard guard on both
                routes, on top of the time-based window. It scales down on a small library so it never
                blocks everything; on a big library, raise it. <strong>0 = off</strong>. Listener requests
                stay exempt. 0&ndash;1000.
              </div>
            </div>
            <div className="field">
              <Label>Artist spacing (slots)</Label>
              <Input
                type="number" min={0} max={25} step={1}
                value={form.llm.artistVarietyWindow}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, llm: { ...f.llm, artistVarietyWindow: e.target.value } }))}
                placeholder="5"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                Best-effort artist spacing across queued, on-air and recent tracks. Both routes try another
                eligible candidate; the pool fallback prefers artists outside this window, including when
                its model call fails. Spacing can relax when eligible choices are limited or a re-pick
                fails, and the picker logs why. <strong>0 = off</strong>; both routes still avoid repeating
                the pick-anchor artist. Listener requests are exempt. 0&ndash;25.
              </div>
            </div>
            <div className="field">
              <Label>Album cooldown (hours)</Label>
              <Input
                type="number" min={0} max={72} step={0.5}
                value={form.picker.albumHours}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, picker: { ...f.picker, albumHours: e.target.value } }))}
                placeholder="0"
                className="max-w-[200px]"
              />
              <div className="field-hint">
                How long a <strong>record</strong> rests after one of its tracks airs. Only worth setting
                above the artist spacing; it yields rather than starving selection, and compilations are
                exempt. <strong>0 = off</strong> (the default). 0&ndash;72.
              </div>
            </div>
          </div>
        </Card>

        <Card title="Minimum track length" sub="keep skits and interludes off air">
          <div className="field">
            <Label>Shortest pickable track (seconds)</Label>
            <Input
              type="number" min={0} max={PICKER_MIN_TRACK_LENGTH_BOUNDS.max} step={1}
              value={form.picker.minTrackLengthSeconds}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, picker: { ...f.picker, minTrackLengthSeconds: e.target.value } }))}
              placeholder="0"
              className="max-w-[200px]"
            />
            <div className="field-hint">
              A selection filter on both routes and the offline fallback playlist: a short track is never
              chosen. A show can set its own; listener requests are always exempt.{' '}
              <strong>0 = off</strong> (the default). A non-zero value must be at least{' '}
              {data?.values?.minTrackSeconds ?? 30}s, the crossfade-derived minimum.
            </div>
          </div>
        </Card>

        <Card title="Guest Musical Leanings" sub="an occasional, secondary taste">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
            <div>
              <div className="text-[13px] font-bold">Let guests nudge a close choice</div>
              <div className="field-hint mt-1 max-w-[440px]">
                An eligible guest&apos;s Musical Leanings can occasionally act as a weaker, secondary
                tie-breaker. It never uses a guest&apos;s Soul and never overrides the host, show rules,
                rotation, safety or the current musical flow. Off by default.
              </div>
            </div>
            <Seg
              accent
              value={form.llm.guestMusicalLeanings ? 'on' : 'off'}
              options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
              onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, guestMusicalLeanings: v === 'on' } }))}
            />
          </div>
        </Card>
      </Advanced>

      <SaveBar
        note="Music selection applies from the next pick · no mixer restart."
        busy={busy}
        onSave={save}
        saveLabel="Save music selection"
        errors={fieldErrors}
        ownedKeys={sectionById('selection')?.formKeys ?? []}
      />
    </>
  );
}
