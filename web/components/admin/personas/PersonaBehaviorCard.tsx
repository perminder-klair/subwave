'use client';
// How this persona talks: talk frequency, script length, DJ mode, and the tone
// dials. Two columns from lg up (settings on the left, dials on the right) so
// the knobs stay grouped instead of spreading across the full editor width.
// Frequency and script length are stepped faders (discrete named stops with
// real scheduling consequences), deliberately distinct from the continuous
// rotary tone knobs.
import type { Persona } from './types';
import { FREQUENCIES, SCRIPT_LENGTHS, TONE_DIALS, toneBandIndex } from './constants';
import { Card, Toggle } from '../ui';
import { SteppedFader } from './SteppedFader';
import { ToneKnob } from './ToneKnob';

interface PersonaBehaviorCardProps {
  persona: Persona;
  update: (patch: Partial<Persona>) => void;
}

export function PersonaBehaviorCard({ persona, update }: PersonaBehaviorCardProps) {
  return (
    <Card flat title="Behaviour" sub="how this persona talks">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        {/* LEFT — frequency, script length, DJ mode */}
        <div>
          <div className="rule-label">talk frequency</div>
          <SteppedFader
            ariaLabel="Talk frequency"
            stops={FREQUENCIES}
            value={persona.frequency || 'moderate'}
            onChange={id => update({ frequency: id })}
          />

          <div className="rule-label">script length</div>
          <SteppedFader
            ariaLabel="Script length"
            stops={SCRIPT_LENGTHS}
            value={persona.scriptLength || 'concise'}
            onChange={id => update({ scriptLength: id })}
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
              on={persona.djMode}
              onClick={() => update({ djMode: !persona.djMode })}
            />
          </div>
        </div>

        {/* RIGHT — tone dials */}
        <div className="mt-4 lg:mt-0">
          <div className="rule-label">tone dials</div>
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            {TONE_DIALS.map(d => {
              const val = persona[d.id];
              return (
                <ToneKnob
                  key={d.id}
                  label={d.label}
                  value={val}
                  band={d.words[toneBandIndex(val)]}
                  low={d.low}
                  high={d.high}
                  onChange={v => update({ [d.id]: v } as Partial<Persona>)}
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
