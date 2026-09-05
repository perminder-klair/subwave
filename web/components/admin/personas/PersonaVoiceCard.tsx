'use client';
// The engine picker and every engine's voice selector live in the shared
// tts/EngineVoiceFields, which the station-wide TTS fallback slot uses too.
//
// `tts` is bound as ONE `useController` over the whole {engine, cloudProvider,
// voice, gainDb, speed} object rather than a SelectField per subfield, for two
// independent reasons. (1) EngineVoiceFields does real cross-field work on
// change — switching engine resets `voice` to one the new engine accepts —
// which needs a callback over the whole slot, not SelectField's hardcoded
// `onValueChange={field.onChange}`. (2) The controller's fieldErrors here are
// block-level too: `ttsVoiceSlotSchema` is one `.transform()` over the slot and
// its issues carry no explicit path, so a bad engine/voice combination comes
// back keyed at `personas.<i>.tts` and never at `.tts.voice`.
import { useId } from 'react';
import { useController, type Control } from 'react-hook-form';
import type { Persona, PersonasFormValues, SettingsResponse } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { fieldAria } from '@/lib/form';
import { Field, FieldLabel, FieldError } from '@/components/ui/field';
import { Card } from '../ui';
import { EngineVoiceFields, ENGINE_UNAVAILABLE } from '../tts/EngineVoiceFields';
import { Label } from '../../ui/label';
import { VoiceMeter } from './VoiceMeter';
import { cn } from '../../../lib/cn';

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

  const gain = tts.gainDb ?? 0;
  const gainLabel = !gain
    ? '0 dB'
    : `${gain > 0 ? '+' : '−'}${Math.abs(gain).toFixed(1)} dB`;

  const speed = tts.speed ?? 1;
  // Only Piper/Kokoro/cloud honour speed; the other workers ignore it, so the
  // control is shown but disabled with a hint.
  const speedSupported = tts.engine !== 'chatterbox' && tts.engine !== 'pocket-tts' && tts.engine !== 'remote';

  return (
    <Card flat title="Voice" sub="text-to-speech engine">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        <Field data-invalid={aria.invalid || undefined} {...aria.groupProps} className="min-w-0">
          {/* No single labelable control across engine + voice, so this Field
              names itself via aria-labelledby (fieldAria's group variant),
              matching BlockRulesCard's "values" chip group. */}
          <FieldLabel asChild className="caption" {...aria.labelledByProps}>
            <span>Engine &amp; voice</span>
          </FieldLabel>
          <EngineVoiceFields
            value={tts}
            onChange={patch => field.onChange({ ...tts, ...patch })}
            data={data}
            adminFetch={adminFetch}
            previewSpeed={tts.speed}
            previewLanguage={persona.language}
            cloudIssue={cloudIssueText && (
              <>
                <strong>This cloud voice won’t play.</strong> {cloudIssueText}{' '}
                Until that’s fixed, this persona falls back to <strong>{defaultEngine}</strong>.
              </>
            )}
            allowInherit
            engineHint={<>
              Each persona can use its own engine and voice, or follow the
              station. The badge on each card shows whether it&apos;s ready in
              this build.
            </>}
            inheritNote={<>
              This persona follows <strong>Settings → TTS voice</strong>, which is
              currently <strong>{defaultEngine}</strong>. On a local engine it
              keeps the voice below; on the cloud voice it uses the station&apos;s
              cloud provider and voice, because a local voice id means nothing to
              a cloud provider.
            </>}
            unavailableNote={engine => (
              <>{ENGINE_UNAVAILABLE[engine]} This persona falls back to{' '}
                <strong>{defaultEngine}</strong> until it&apos;s up.</>
            )}
            previewHint={<>
              Plays a short sample in this persona&apos;s voice, and language
              when one is set. Reflects the voice and speed; the dB trim is
              applied later, on air.
            </>}
          />
          <FieldError
            {...aria.errorProps}
            errors={fieldState.error ? [fieldState.error] : undefined}
          />
        </Field>

        <div className="field mt-3.5 max-w-[360px] lg:mt-0 lg:max-w-[460px]">
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
                ? <>Slow down or speed up this persona on top of the engine pace. <code>1.00×</code> = no change.</>
                : <>Not supported by this engine; only Piper, Kokoro and cloud honour speed.</>}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
