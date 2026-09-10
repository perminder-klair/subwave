'use client';

import { Label } from '../../ui/label';
import { Input } from '../../ui/input';
import { Card, Seg } from '../ui';
import { fieldAria } from '../../../lib/form';
import {
  SectionHeader, SaveBar, SettingsFieldError, settingsFieldAria,
  type SectionProps,
} from './shared';

/**
 * Home for decisions about WHEN and HOW the DJ speaks, rather than the engine
 * which renders that speech. Keep policy controls here as they are introduced
 * so the TTS panel remains concerned solely with voice configuration.
 */
export function DjBehaviourSection({ form, setForm, busy, saveSettings, fieldErrors }: SectionProps) {
  const talkPlacementAria = fieldAria('dj-talk-placement', undefined, { hasDescription: true });
  const linkStyleAria = fieldAria('dj-link-release-year', undefined, { hasDescription: true });
  const pauseTalkAria = settingsFieldAria(
    'pause-talk-min-seconds',
    fieldErrors.pauseTalkMinSeconds,
  );
  const save = async () => {
    await saveSettings({
      djTalkOnlyBetweenTracks: form.djTalkOnlyBetweenTracks,
      pauseTalkMinSeconds: Number(form.pauseTalkMinSeconds),
      djBehaviour: form.djBehaviour,
    });
  };

  return (
    <>
      <SectionHeader
        eyebrow="dj behaviour"
        title="Decide how the DJ occupies the station."
        sub="These controls shape speech placement and show-boundary behaviour. Voice engines and voices stay under TTS voice."
      />

      <Card title="Talk placement" sub={form.djTalkOnlyBetweenTracks ? 'between tracks' : 'any time'}>
        <div className="field">
          <Label {...talkPlacementAria.labelledByProps}>Scheduled speech</Label>
          <Seg
            {...talkPlacementAria.groupProps}
            value={form.djTalkOnlyBetweenTracks ? 'between' : 'any'}
            options={[
              { id: 'any', label: 'Any time', title: 'Scheduled segments air on the minute they are written' },
              { id: 'between', label: 'Between tracks', title: 'Scheduled segments wait for the next track boundary' },
            ]}
            onChange={v => setForm(f => ({ ...f, djTalkOnlyBetweenTracks: v === 'between' }))}
          />
          <p {...talkPlacementAria.descriptionProps} className="mt-2 text-[13px] leading-[1.55] text-muted">
            {form.djTalkOnlyBetweenTracks ? (
              <>
                Every <strong>scheduled</strong> segment — station IDs, the hourly time
                check, banter, programme beats and between-track segments — is written
                ahead of time and held for the <strong>next track boundary</strong>, so the
                DJ never ducks a song mid-play. A segment can therefore air a track later
                than its scheduled minute; stale time-sensitive speech is dropped.
              </>
            ) : (
              <>
                Scheduled segments air on the minute they are written, ducking the current
                song. <strong>Station IDs are the exception</strong> and always wait for the
                next track boundary. Turn this on to give every scheduled segment the same
                between-track treatment.
              </>
            )}
          </p>
        </div>
      </Card>

      <Card title="Pause-and-talk" sub={`${form.pauseTalkMinSeconds}s minimum`}>
        <div className="field" data-invalid={pauseTalkAria.invalid || undefined}>
          <Label {...pauseTalkAria.labelProps}>Minimum segment length</Label>
          <Input
            {...pauseTalkAria.controlProps}
            type="number"
            min="5"
            max="90"
            step="1"
            value={form.pauseTalkMinSeconds}
            onChange={e => setForm(f => ({ ...f, pauseTalkMinSeconds: e.target.value }))}
          />
          <p className="mt-2 text-[13px] leading-[1.55] text-muted">
            On shows with Pause-and-talk enabled, eligible skill segments at least
            this long pause the music and speak in the clear. Shorter segments keep
            the usual ducked delivery.
          </p>
          <SettingsFieldError
            path="pauseTalkMinSeconds"
            errors={fieldErrors}
            {...pauseTalkAria.errorProps}
          />
        </div>
      </Card>

      <Card title="Show changes" sub={form.djBehaviour.showWelcome ? 'welcome at the hour' : 'quiet'}>
        <div className="field">
          <Label>Welcome the new show</Label>
          <Seg
            value={form.djBehaviour.showWelcome ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off', title: 'Keep the normal hourly time check' },
              { id: 'on', label: 'On', title: 'Extend the first hourly check with a welcome to the new show' },
            ]}
            onChange={v => setForm(f => ({ ...f, djBehaviour: { ...f.djBehaviour, showWelcome: v === 'on' } }))}
          />
          <p className="mt-2 text-[13px] leading-[1.55] text-muted">
            At a scheduled show change, the incoming DJ’s first hourly time check adds a
            short natural welcome to the new show. It does not replace a presenter handoff,
            and ordinary hourly checks stay unchanged.
          </p>
        </div>
        <div className="field mt-5">
          <Label>Acknowledge a same-host change</Label>
          <Seg
            value={form.djBehaviour.sameHostAcknowledgement ? 'on' : 'off'}
            options={[
              { id: 'off', label: 'Off', title: 'Keep adjacent shows by the same DJ quiet' },
              { id: 'on', label: 'On', title: 'Let the DJ briefly acknowledge moving into their next show' },
            ]}
            onChange={v => setForm(f => ({ ...f, djBehaviour: { ...f.djBehaviour, sameHostAcknowledgement: v === 'on' } }))}
          />
          <p className="mt-2 text-[13px] leading-[1.55] text-muted">
            When the same DJ hosts two adjacent scheduled shows, add one brief spoken
            acknowledgement of the new show. Different-DJ handoffs keep their normal
            sign-off and greeting.
          </p>
        </div>
      </Card>

      <Card title="Link style" sub={form.djBehaviour.releaseYearMentions + ' release-year mentions'}>
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
            onChange={v => setForm(f => ({
              ...f,
              djBehaviour: { ...f.djBehaviour, releaseYearMentions: v as typeof f.djBehaviour.releaseYearMentions },
            }))}
          />
          <p {...linkStyleAria.descriptionProps} className="mt-2 text-[13px] leading-[1.55] text-muted">
            Release years stay verified in the library. This controls how often one is supplied
            to the DJ for a link, keeping factual grounding intact without making every link sound like metadata.
          </p>
        </div>
      </Card>

      <Card title="Extended Sleeve Notes" sub="coming soon">
        <p className="text-[13px] leading-[1.55] text-muted">
          Soon, the DJ will be able to add optional, source-backed editorial notes—such as
          release credits or wider artist context—with provider provenance. Album, trusted
          release year and station-play history already come from today&apos;s Verified Facts
          packet; this future layer will stay opt-in and separate from show steering.
        </p>
      </Card>

      <SaveBar
        note="DJ behaviour applies to newly scheduled speech straight away · no mixer restart."
        busy={busy}
        onSave={save}
        saveLabel="Save DJ behaviour"
        errors={fieldErrors}
        ownedKeys={['djTalkOnlyBetweenTracks', 'pauseTalkMinSeconds', 'djBehaviour']}
      />
    </>
  );
}
