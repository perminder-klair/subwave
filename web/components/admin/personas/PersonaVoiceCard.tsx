'use client';
// Bind the whole TTS slot because changing engines resets the voice and server errors name the slot.
import { useId } from 'react';
import { useController, type Control } from 'react-hook-form';
import type { Persona, PersonaFallbackVoice, PersonasFormValues, SettingsResponse } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { fieldAria } from '@/lib/form';
import { TextareaField } from '@/lib/form-fields';
import { Field, FieldLabel, FieldError } from '@/components/ui/field';
import { Card, Seg } from '../ui';
import { EngineVoiceFields, ENGINE_UNAVAILABLE } from '../tts/EngineVoiceFields';
import { effectiveTts } from './helpers';
import { Label } from '../../ui/label';
import { VoiceMeter } from './VoiceMeter';
import { cn } from '../../../lib/cn';
import { PERSONA_VOICE_STYLE_MAX, composeTtsControlSpeeds } from '../../../lib/schemas.generated';

// What turning a rescue voice On starts from: the always-available local floor.
const RESCUE_SEED: PersonaFallbackVoice = { engine: 'piper', cloudProvider: 'openai', voice: '' };

interface PersonaVoiceCardProps {
  persona: Persona; // read-only: language (preview) + on-screen labels only
  index: number;
  control: Control<PersonasFormValues>;
  data: SettingsResponse | null;
  defaultEngine: string;
  cloudIssueText: string | null;
  adminFetch: AdminAuth['adminFetch'];
}

export function PersonaVoiceCard({
  persona, index, control, data, defaultEngine, cloudIssueText, adminFetch,
}: PersonaVoiceCardProps) {
  const { field, fieldState } = useController({ control, name: `personas.${index}.tts` });
  const tts = field.value;
  const uid = useId();
  const aria = fieldAria(`${uid}-tts`, fieldState.error);

  // The persona's own rescue voice (#2029), tried before the station Fallback
  // voice when this persona's engine fails. null = none.
  const { field: rescueField, fieldState: rescueState } = useController({
    control, name: `personas.${index}.fallbackVoice`,
  });
  const rescue = rescueField.value;
  const rescueAria = fieldAria(`${uid}-rescue`, rescueState.error);
  // Checked per provider, as on the station Fallback card: a cloud rescue whose
  // provider has no key is skipped at rescue time.
  const rescueCloudUnconfigured = rescue?.engine === 'cloud'
    && rescue.cloudProvider !== 'openai-compatible'
    && data?.tts?.available?.cloudByProvider?.[rescue.cloudProvider] === false;

  const gain = tts.gainDb ?? 0;
  const gainLabel = !gain
    ? '0 dB'
    : `${gain > 0 ? '+' : '−'}${Math.abs(gain).toFixed(1)} dB`;

  const speed = tts.speed ?? 1;
  // Chatterbox/PocketTTS do not honour speed, so the control is shown but
  // disabled there. Asked of the RESOLVED engine: a persona on the station
  // default has no engine of its own.
  const resolved = effectiveTts({ tts }, data);
  const resolvedEngine = resolved?.engine;
  const speedSupported =
    resolvedEngine !== 'chatterbox' && resolvedEngine !== 'pocket-tts';
  // Previews are deterministic auditions of the two saved controls. The live
  // dispatcher adds the current daypart/show factor later, at air time.
  const previewSpeed = composeTtsControlSpeeds(
    resolvedEngine ? data?.values?.tts?.speed?.[resolvedEngine] : undefined,
    speed,
  );

  return (
    <Card flat title="Voice" sub="text-to-speech engine">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        <Field data-invalid={aria.invalid || undefined} {...aria.groupProps} className="min-w-0">
          {/* Use a labelled group because engine and voice are separate controls. */}
          <FieldLabel asChild className="caption" {...aria.labelledByProps}>
            <span>Engine &amp; voice</span>
          </FieldLabel>
          <EngineVoiceFields
            value={tts}
            onChange={patch => field.onChange({ ...tts, ...patch })}
            data={data}
            adminFetch={adminFetch}
            previewSpeed={previewSpeed}
            previewLanguage={persona.language}
            previewVoiceStyle={persona.voiceStyle}
            cloudIssue={cloudIssueText && (
              <>
                <strong>This cloud voice won’t play.</strong> {cloudIssueText}{' '}
                Until that’s fixed, this persona falls back to <strong>{defaultEngine}</strong>.
              </>
            )}
            allowInherit
            inheritResolvesTo={resolved ?? null}
            engineHint={<>
              Each persona can use its own engine and voice, or follow the
              station. The badge on each card shows whether it&apos;s ready in
              this build.
            </>}
            inheritNote={<>
              This persona follows <strong>Settings → TTS voice</strong>, which is
              currently <strong>{defaultEngine}</strong>.{' '}
              {resolvedEngine === 'piper' || resolvedEngine === 'kokoro'
                ? <>Piper and Kokoro share one voice id-space, so the voice below
                    is the one that will speak — and it follows the station if you
                    switch between those two.</>
                : <>{defaultEngine} takes its voice from the station rather than
                    from this persona, so there is no voice to set here. Switch the
                    station to Piper or Kokoro, or pin an engine above, to give
                    this persona a voice of its own.</>}{' '}
              The sample below combines the saved station and persona speeds;
              the current programme can shape delivery further on air.
            </>}
            unavailableNote={engine => (
              <>{ENGINE_UNAVAILABLE[engine]} This persona falls back to{' '}
                <strong>{defaultEngine}</strong> until it&apos;s up.</>
            )}
            previewHint={<>
              Plays a short sample in this persona&apos;s voice, and language
              when one is set. It combines the saved engine and persona speeds;
              programme pacing and the dB trim are applied later, on air.
            </>}
          />
          <FieldError
            {...aria.errorProps}
            errors={fieldState.error ? [fieldState.error] : undefined}
          />
        </Field>

        <div className="field mt-3.5 max-w-[360px] lg:mt-0 lg:max-w-[460px]">
          {resolvedEngine === 'gemini' && (
            <TextareaField
              control={control}
              name={`personas.${index}.voiceStyle`}
              label="Delivery style"
              description="How Gemini should sound. Try warm and unhurried, or dry and understated. The sample uses your current style."
              maxLength={PERSONA_VOICE_STYLE_MAX}
              rows={3}
              placeholder="Warm and unhurried"
            />
          )}
          <div className="flex items-baseline justify-between gap-3">
            <Label>Voice level (dB)</Label>
            <span className="font-mono text-[15px] font-extrabold text-[var(--accent)] tabular-nums">{gainLabel}</span>
          </div>
          <VoiceMeter
            value={gain}
            onChange={v => field.onChange({ ...tts, gainDb: v })}
          />
          <div className="mt-1.5 flex justify-between text-[8px] font-bold tracking-[0.1em] text-muted tabular-nums">
            <span>−12 dB</span>
            <span className="-translate-x-1/2">0</span>
            <span>+12 dB</span>
          </div>
          <div className="field-hint">
            Trim this persona’s loudness on top of the engine level. <code>0 dB</code> = no change.
            Drag the meter or use the arrow keys.
          </div>

          <div className="field mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <Label>Speech speed</Label>
              <span className="font-mono text-[15px] font-extrabold text-[var(--accent)] tabular-nums">{speed.toFixed(2)}×</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={speed}
              disabled={!speedSupported}
              onChange={e => field.onChange({ ...tts, speed: Number(e.target.value) })}
              aria-label="Speech speed multiplier"
              className={cn(
                'mt-1.5 w-full accent-[var(--accent)]',
                !speedSupported && 'opacity-40',
              )}
            />
            <div className="mt-1.5 flex justify-between text-[8px] font-bold tracking-[0.1em] text-muted tabular-nums">
              <span>0.5× slower</span>
              <span className="-translate-x-1/2">1.0×</span>
              <span>2.0× faster</span>
            </div>
            <div className="field-hint">
              {speedSupported
                ? resolvedEngine === 'remote'
                  ? <>Slow down or speed up this persona on top of the engine pace. <code>1.00×</code> = no change. Remote applies the composed preview rate locally with ffmpeg when available; the current programme may shape it further on air. Without ffmpeg, it uses the original audio.</>
                  : <>Slow down or speed up this persona on top of the engine pace. <code>1.00×</code> = no change.</>
                : <>Not supported by this engine; Piper, Kokoro, cloud and Remote honour speed.</>}
            </div>
          </div>
        </div>
      </div>

      <Field
        data-invalid={rescueAria.invalid || undefined}
        {...rescueAria.groupProps}
        className="mt-6 min-w-0 border-t border-[var(--ink-soft)] pt-4"
      >
        <FieldLabel asChild className="caption" {...rescueAria.labelledByProps}>
          <span>Rescue voice</span>
        </FieldLabel>
        <Seg
          aria-label="Rescue voice"
          value={rescue ? 'on' : 'off'}
          options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
          onChange={v => rescueField.onChange(v === 'on' ? (rescue ?? RESCUE_SEED) : null)}
        />
        <div className="field-hint max-w-[70ch]">
          Used only when this persona&apos;s own engine fails, and tried before the
          station&apos;s <strong>Fallback voice</strong>. Off, a failed line is
          rescued in the station&apos;s fallback voice, which is the same for every
          persona. On a co-hosted show, give each host a rescue voice of their own
          so one host never airs sounding like the other. Keys and servers come
          from <strong>Settings → TTS voice</strong>.
        </div>
        {rescue && (
          <div className="mt-4 max-w-[560px]">
            <EngineVoiceFields
              value={rescue}
              onChange={patch => rescueField.onChange({ ...rescue, ...patch })}
              data={data}
              adminFetch={adminFetch}
              previewLanguage={persona.language}
              engineHint={<>
                Pick an engine that doesn&apos;t share this persona&apos;s point of
                failure — a local engine is the safest rescue.
              </>}
              unavailableNote={engine => (
                <>{ENGINE_UNAVAILABLE[engine]} A rescue voice that can&apos;t speak
                  is skipped, so this persona drops to the station&apos;s{' '}
                  <strong>Fallback voice</strong> instead.</>
              )}
              cloudIssue={rescueCloudUnconfigured && (
                <>
                  <strong>This rescue voice won’t play.</strong> No API key is
                  configured for that cloud provider. Until then it is skipped,
                  and this persona drops to the station&apos;s{' '}
                  <strong>Fallback voice</strong>.
                </>
              )}
              previewHint={<>
                Plays a short sample in the rescue voice. You&apos;ll normally only
                hear it when something has already gone wrong.
              </>}
            />
          </div>
        )}
        <FieldError
          {...rescueAria.errorProps}
          errors={rescueState.error ? [rescueState.error] : undefined}
        />
      </Field>
    </Card>
  );
}
