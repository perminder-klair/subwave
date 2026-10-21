'use client';

import type { ReactNode } from 'react';
import { Label } from '../../ui/label';
import { Input } from '../../ui/input';
import { Card, Seg } from '../ui';
import { fieldAria } from '../../../lib/form';
import { Advanced } from './section-chrome';
import {
  SectionHeader, SaveBar, SettingsFieldError, settingsFieldAria,
  type SectionProps,
} from './shared';
import { sectionById } from './registry';
import {
  DJ_RECAP_CHARS_BOUNDS,
  DJ_RECAP_LIMIT_BOUNDS,
  DJ_RECAP_MINUTES_BOUNDS,
} from '@/lib/schemas.generated';

/**
 * One on/off cue: the label and its explanation on the left, the switch on the
 * right, the same row shape as Idle behaviour and the other on/off settings.
 */
function CueRow({ id, label, hint, on, onChange }: {
  id: string;
  label: string;
  hint: ReactNode;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const aria = fieldAria(id, undefined, { hasDescription: true });
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
      <div>
        <div {...aria.labelledByProps} className="text-[13px] font-bold">{label}</div>
        <div {...aria.descriptionProps} className="field-hint mt-1 max-w-[440px]">{hint}</div>
      </div>
      <Seg
        {...aria.groupProps}
        accent
        value={on ? 'on' : 'off'}
        options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
        onChange={v => onChange(v === 'on')}
      />
    </div>
  );
}

/**
 * Home for decisions about WHEN and HOW the DJ speaks, rather than the engine
 * which renders that speech (TTS voice) or what plays (Music selection).
 */
export function DjBehaviourSection({ form, setForm, busy, saveSettings, fieldErrors }: SectionProps) {
  const talkPlacementAria = fieldAria('dj-talk-placement', undefined, { hasDescription: true });
  const segmentRuntimeAria = fieldAria('dj-segment-runtime', undefined, { hasDescription: true });
  const linkStyleAria = fieldAria('dj-link-release-year', undefined, { hasDescription: true });
  const pauseTalkAria = settingsFieldAria('pause-talk-min-seconds', fieldErrors.pauseTalkMinSeconds);
  const recapLimitAria = settingsFieldAria('dj-recap-limit', fieldErrors['djBehaviour.recapLimit']);
  const recapMinutesAria = settingsFieldAria('dj-recap-minutes', fieldErrors['djBehaviour.recapMinutes']);
  const recapCharsAria = settingsFieldAria('dj-recap-chars', fieldErrors['djBehaviour.recapChars']);
  const setBehaviour = (patch: Partial<typeof form.djBehaviour>) =>
    setForm(f => ({ ...f, djBehaviour: { ...f.djBehaviour, ...patch } }));

  const save = async () => {
    await saveSettings({
      djTalkOnlyBetweenTracks: form.djTalkOnlyBetweenTracks,
      pauseTalkMinSeconds: Number(form.pauseTalkMinSeconds),
      djBehaviour: {
        ...form.djBehaviour,
        recapLimit: Number(form.djBehaviour.recapLimit),
        recapMinutes: Number(form.djBehaviour.recapMinutes),
        recapChars: Number(form.djBehaviour.recapChars),
      },
      llm: {
        segmentRuntime: form.llm.segmentRuntime,
      },
    });
  };

  const cuesOn = [form.djBehaviour.previewNextShow, form.djBehaviour.showWelcome, form.djBehaviour.sameHostAcknowledgement]
    .filter(Boolean).length;

  return (
    <>
      <SectionHeader
        eyebrow="dj behaviour"
        title="When and how the DJ speaks."
        sub="Where scheduled speech lands, how segments gather their facts, and the cues around a show change. Voices live under TTS voice; what plays lives under Music selection."
      />

      <Card title="Talk placement" sub="when scheduled speech may air">
        <div className="field">
          <Label {...talkPlacementAria.labelledByProps}>Scheduled speech</Label>
          <Seg
            {...talkPlacementAria.groupProps}
            accent
            value={form.djTalkOnlyBetweenTracks ? 'between' : 'any'}
            options={[
              { id: 'any', label: 'Any time', title: 'Scheduled segments air on the minute they are written' },
              { id: 'between', label: 'Between tracks', title: 'Scheduled segments wait for the next track boundary' },
            ]}
            onChange={v => setForm(f => ({ ...f, djTalkOnlyBetweenTracks: v === 'between' }))}
          />
          <div {...talkPlacementAria.descriptionProps} className="field-hint">
            {form.djTalkOnlyBetweenTracks ? (
              <>
                Every <strong>scheduled</strong> segment (station IDs, the hourly time check, banter,
                programme beats and between-track segments) is written ahead and held for the{' '}
                <strong>next track boundary</strong>, so the DJ never ducks a song mid-play. A segment can
                air a track later than its minute; stale time-sensitive speech is dropped.
              </>
            ) : (
              <>
                Scheduled segments air on the minute they are written, ducking the current song.{' '}
                <strong>Station IDs are the exception</strong> and always wait for the next track
                boundary. Choose Between tracks to give every scheduled segment that treatment.
              </>
            )}
          </div>
        </div>
      </Card>

      <Card title="Segments & Skills" sub="how a segment gathers its facts">
        <div className="field">
          <Label {...segmentRuntimeAria.labelledByProps}>Runtime</Label>
          <Seg
            {...segmentRuntimeAria.groupProps}
            value={form.llm.segmentRuntime}
            options={[
              { id: 'direct', label: 'Direct', title: 'The controller fetches evidence, then the DJ writes one bounded response' },
              { id: 'agentic', label: 'Agentic', title: 'The DJ may use its tools to research and prepare a segment' },
            ]}
            onChange={v => setForm(f => ({ ...f, llm: { ...f.llm, segmentRuntime: v as 'agentic' | 'direct' } }))}
          />
          <div {...segmentRuntimeAria.descriptionProps} className="field-hint">
            Both use the same briefs, schedules, cooldowns and evidence rules. <strong>Direct</strong>{' '}
            fetches the skill&apos;s data in the controller and makes one writing call, and suits small or
            local models. <strong>Agentic</strong> lets a tool-capable model decide how to use the skill&apos;s
            tools; its runs share the agent deadline under Music selection.
          </div>
        </div>
      </Card>

      <Card title="Show changes" sub={cuesOn ? `${cuesOn} of 3 on-air cues on` : 'cues around a scheduled change'}>
        <div className="grid gap-5">
          <CueRow
            id="dj-preview-next-show"
            label="Preview the next show"
            hint="Near a scheduled change, the outgoing DJ may mention the following presenter’s show. The presenter handoff still happens normally."
            on={!!form.djBehaviour.previewNextShow}
            onChange={on => setBehaviour({ previewNextShow: on })}
          />
          <CueRow
            id="dj-welcome-new-show"
            label="Welcome the new show"
            hint="The incoming DJ’s first hourly time check adds a short welcome to the new show. It does not replace the handoff, and ordinary hourly checks stay unchanged."
            on={!!form.djBehaviour.showWelcome}
            onChange={on => setBehaviour({ showWelcome: on })}
          />
          <CueRow
            id="dj-same-host"
            label="Acknowledge a same-host change"
            hint="When one DJ hosts two adjacent shows, add one brief spoken acknowledgement of the new show. Different-DJ handoffs keep their sign-off and greeting."
            on={!!form.djBehaviour.sameHostAcknowledgement}
            onChange={on => setBehaviour({ sameHostAcknowledgement: on })}
          />
        </div>
      </Card>

      <Card title="Link style" sub="how links use release years">
        <div className="field">
          <Label {...linkStyleAria.labelledByProps}>Release-year mentions</Label>
          <Seg
            {...linkStyleAria.groupProps}
            value={form.djBehaviour.releaseYearMentions}
            options={[
              { id: 'regular', label: 'Regular', title: 'Keep release years available on every eligible link' },
              { id: 'occasional', label: 'Occasional', title: 'Make release years available on roughly one in four eligible links' },
              { id: 'rare', label: 'Rare', title: 'Make release years available on roughly one in six eligible links' },
            ]}
            onChange={v => setBehaviour({ releaseYearMentions: v as typeof form.djBehaviour.releaseYearMentions })}
          />
          <div {...linkStyleAria.descriptionProps} className="field-hint">
            Release years stay verified in the library. This sets how often one is handed to the DJ for a
            link, so links stay grounded without every one sounding like metadata.
          </div>
        </div>
      </Card>

      <Advanced note="the pause-and-talk threshold, prompt memory and what's coming">
        <Card title="Pause-and-talk" sub="the length that earns a real pause">
          <div className="field" data-invalid={pauseTalkAria.invalid || undefined}>
            <Label {...pauseTalkAria.labelProps}>Minimum segment length (seconds)</Label>
            <Input
              {...pauseTalkAria.controlProps}
              type="number" min="5" max="90" step="1"
              value={form.pauseTalkMinSeconds}
              onChange={e => setForm(f => ({ ...f, pauseTalkMinSeconds: e.target.value }))}
              className="max-w-[200px]"
            />
            <div className="field-hint">
              On shows with Pause-and-talk enabled, eligible skill segments at least this long pause the
              music and speak in the clear. Shorter segments keep the usual ducked delivery. 5&ndash;90.
            </div>
            <SettingsFieldError path="pauseTalkMinSeconds" errors={fieldErrors} {...pauseTalkAria.errorProps} />
          </div>
        </Card>

        <Card title="Prompt memory" sub={`${form.djBehaviour.recapLimit} lines · ${form.djBehaviour.recapMinutes} min`}>
          <div className="grid gap-5 sm:grid-cols-3">
            <div className="field" data-invalid={recapLimitAria.invalid || undefined}>
              <Label {...recapLimitAria.labelProps}>Recent lines</Label>
              <Input
                {...recapLimitAria.controlProps}
                type="number" min={DJ_RECAP_LIMIT_BOUNDS.min} max={DJ_RECAP_LIMIT_BOUNDS.max} step="1"
                value={form.djBehaviour.recapLimit}
                onChange={e => setBehaviour({ recapLimit: e.target.value })}
              />
              <SettingsFieldError path="djBehaviour.recapLimit" errors={fieldErrors} {...recapLimitAria.errorProps} />
            </div>
            <div className="field" data-invalid={recapMinutesAria.invalid || undefined}>
              <Label {...recapMinutesAria.labelProps}>Lookback (minutes)</Label>
              <Input
                {...recapMinutesAria.controlProps}
                type="number" min={DJ_RECAP_MINUTES_BOUNDS.min} max={DJ_RECAP_MINUTES_BOUNDS.max} step="1"
                value={form.djBehaviour.recapMinutes}
                onChange={e => setBehaviour({ recapMinutes: e.target.value })}
              />
              <SettingsFieldError path="djBehaviour.recapMinutes" errors={fieldErrors} {...recapMinutesAria.errorProps} />
            </div>
            <div className="field" data-invalid={recapCharsAria.invalid || undefined}>
              <Label {...recapCharsAria.labelProps}>Characters per line</Label>
              <Input
                {...recapCharsAria.controlProps}
                type="number" min={DJ_RECAP_CHARS_BOUNDS.min} max={DJ_RECAP_CHARS_BOUNDS.max} step="1"
                value={form.djBehaviour.recapChars}
                onChange={e => setBehaviour({ recapChars: e.target.value })}
              />
              <SettingsFieldError path="djBehaviour.recapChars" errors={fieldErrors} {...recapCharsAria.errorProps} />
            </div>
          </div>
          <div className="field-hint mt-3">
            Every DJ script carries this much recent aired speech so the host can avoid repeating topics
            and phrasing. Larger values use more model context. The session rolls after four hours;
            extended and storyteller segments keep their longer per-line detail automatically.
          </div>
        </Card>

        <Card title="Extended Sleeve Notes" sub="coming soon">
          <div className="field-hint">
            Soon, the DJ will be able to add optional, source-backed editorial notes, such as release
            credits or wider artist context, with provider provenance. Album, trusted release year and
            station-play history already come from today&apos;s Verified Facts packet; this future layer
            will stay opt-in and separate from show steering.
          </div>
        </Card>
      </Advanced>

      <SaveBar
        note="DJ behaviour applies to newly scheduled speech straight away · no mixer restart."
        busy={busy}
        onSave={save}
        saveLabel="Save DJ behaviour"
        errors={fieldErrors}
        ownedKeys={sectionById('behaviour')?.formKeys ?? []}
      />
    </>
  );
}
