'use client';
// How this persona talks: talk frequency, script length, DJ mode and the tone
// dials. Frequency and script length are stepped faders (discrete named stops),
// deliberately distinct from the continuous rotary tone knobs.
//
// Every control here is a custom rotary/fader/toggle whose shape the five
// shared bound components (TextField/SelectField/…) don't cover, so each is
// wired through its own `useController` — real RHF state, just not the
// generic wrapper. SteppedFader/ToneKnob/Toggle already take plain
// `value`/`onChange(v)` props, which is exactly `field.value`/`field.onChange`,
// so no adapter is needed at any of the four sites below.
import { useController, type Control } from 'react-hook-form';
import type { PersonasFormValues } from './types';
import { FREQUENCIES, LINK_STYLES, SCRIPT_LENGTHS, TONE_DIALS, toneBandIndex } from './constants';
import { Card, Toggle } from '../ui';
import { SteppedFader } from './SteppedFader';
import { ToneKnob } from './ToneKnob';

interface PersonaBehaviorCardProps {
  index: number;
  control: Control<PersonasFormValues>;
}

export function PersonaBehaviorCard({ index, control }: PersonaBehaviorCardProps) {
  const frequency = useController({ control, name: `personas.${index}.frequency` });
  const scriptLength = useController({ control, name: `personas.${index}.scriptLength` });
  const djMode = useController({ control, name: `personas.${index}.djMode` });
  const linkStyle = useController({ control, name: `personas.${index}.linkStyle` });
  const humour = useController({ control, name: `personas.${index}.humour` });
  const localColour = useController({ control, name: `personas.${index}.localColour` });
  const warmth = useController({ control, name: `personas.${index}.warmth` });
  const dials = { humour, localColour, warmth } as const;

  return (
    <Card flat title="Behaviour" sub="how this persona talks">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        <div>
          <div className="rule-label">talk frequency</div>
          <SteppedFader
            ariaLabel="Talk frequency"
            stops={FREQUENCIES}
            value={frequency.field.value || 'moderate'}
            onChange={frequency.field.onChange}
          />

          <div className="rule-label">script length</div>
          <SteppedFader
            ariaLabel="Script length"
            stops={SCRIPT_LENGTHS}
            value={scriptLength.field.value || 'concise'}
            onChange={scriptLength.field.onChange}
          />

          <div className="rule-label">DJ mode</div>
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[13px] font-bold">Work the desk like a real DJ</div>
              <div className="mt-0.5 text-[11px] text-muted">
                Back-announces and teases what&apos;s coming next, runs callbacks across the
                hour, and talks more often. Off keeps this persona a tasteful between-track
                narrator.
              </div>
            </div>
            <Toggle
              on={djMode.field.value}
              onClick={() => djMode.field.onChange(!djMode.field.value)}
              ariaLabel="Work the desk like a real DJ"
            />
          </div>

          <div className="rule-label">link style</div>
          <SteppedFader
            ariaLabel="Link style"
            stops={LINK_STYLES}
            value={linkStyle.field.value || 'natural'}
            onChange={linkStyle.field.onChange}
          />
        </div>

        <div className="mt-4 lg:mt-0">
          <div className="rule-label">tone dials</div>
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            {TONE_DIALS.map(d => {
              const dial = dials[d.id];
              const val = dial.field.value;
              return (
                <ToneKnob
                  key={d.id}
                  label={d.label}
                  value={val}
                  band={d.words[toneBandIndex(val)]}
                  low={d.low}
                  high={d.high}
                  onChange={dial.field.onChange}
                />
              );
            })}
          </div>
          <div className="field-hint mt-3.5">
            Personality on top of the soul. The middle band (4–6) injects nothing, so the
            default stays exactly as before; turn a dial low or high to shift the voice.
          </div>
        </div>
      </div>
    </Card>
  );
}
